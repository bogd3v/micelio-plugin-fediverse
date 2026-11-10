import { createHash } from 'node:crypto'

import type { Core } from '@strapi/strapi'

import type { Context } from '@fedify/fedify'
import { PUBLIC_COLLECTION, type Activity } from '@fedify/fedify/vocab'

import { ActorUpdate } from '../attributed-actor'
import { ACTOR_IDENTIFIER } from '../constants/actor'
import { ARTICLE_UID, GLOBAL_UID, SITE_UID } from '../constants/uids'
import { buildActor, getFederation } from '../federation'
import {
  buildArticleActivity,
  buildDeleteActivity,
  findPublishedArticle,
  getDefaultLocale,
} from './articles'
import { getObjectType } from './object-type'
import {
  activityTypeFor,
  findFederatedArticle,
  isFederated,
  recordFailure,
  recordSend,
} from './federated-articles'
import { listFollowers } from './followers'
import type { FederatedActivityType } from '../types/federated-articles'
import type { FediverseContextData } from '../types/federation'

interface EntryEvent {
  uid?: string
  entry?: { documentId?: string; locale?: string | null } | null
}

/** How long a save in a non-default locale waits for i18n to copy the shared fields. */
const LOCALE_SYNC_DELAY_MS = 1000

let unsubscribers: Array<() => void> = []

/**
 * Fedify context for work that isn't tied to an HTTP request. Its origin comes
 * from Strapi's public `URL`, so ids match the ones served over HTTP.
 */
export function createContext(strapi: Core.Strapi): Context<FediverseContextData> {
  const origin = strapi.config.get('server.url') as string
  return getFederation(strapi).createContext(new URL(origin), { strapi })
}

/** An actor outside the followers an activity is also delivered to: its id and its inbox. */
export interface ExtraRecipient {
  id: URL | null
  inboxId: URL | null
  /** The actor's endpoints, so a shared inbox can be used. */
  endpoints?: { sharedInbox: URL | null } | null
}

/** How many followers an activity was queued for, and how many were left out as unreachable. */
export interface FanOut {
  queued: number
  skipped: number
}

/**
 * Queues the activity for every active follower not flagged unreachable.
 *
 * @remarks
 * Returns once the activity is enqueued; Fedify's queue delivers and retries it
 * in the background. A follower is unreachable after its inbox answered `404`
 * or `410`, until it sends us an activity again (`markReachable`).
 */
export async function sendToFollowers(
  strapi: Core.Strapi,
  activity: Activity,
  extra: ExtraRecipient[] = [],
  site?: string
): Promise<FanOut> {
  const followers = await listFollowers(strapi, { site })
  const reachable = followers.filter((follower) => follower.unreachableSince == null)
  const skipped = followers.length - reachable.length
  if (reachable.length === 0 && extra.length === 0) return { queued: 0, skipped }

  const ctx = createContext(strapi)
  await ctx.sendActivity(
    { identifier: ACTOR_IDENTIFIER },
    [
      ...extra,
      ...reachable.map((follower) => ({
        id: new URL(follower.actorId),
        inboxId: follower.inbox ? new URL(follower.inbox) : null,
      })),
    ],
    activity,
    { preferSharedInbox: true }
  )
  return { queued: reachable.length, skipped }
}

/**
 * Records the activity on the article's row, queues it and, when enqueueing
 * throws, marks the row failed with the reason before rethrowing for the caller
 * to log. A delivery that fails later is recorded by `settleDelivery`.
 */
async function sendRecorded(
  strapi: Core.Strapi,
  documentId: string,
  type: FederatedActivityType,
  activity: Activity,
  firstPublishedAt?: string,
  site?: string
): Promise<FanOut> {
  const activityAt = await recordSend(strapi, documentId, type, firstPublishedAt, site)
  try {
    return await sendToFollowers(strapi, activity, [], site)
  } catch (error) {
    await recordFailure(strapi, documentId, activityAt, error, site)
    throw error
  }
}

/** The log text of a fan-out: how many followers it was queued for. */
export function describeFanOut({ queued, skipped }: FanOut): string {
  const left = skipped > 0 ? ` (${skipped} unreachable skipped)` : ''
  if (queued > 0) return `queued for ${queued} follower${queued === 1 ? '' : 's'}${left}`
  return skipped > 0
    ? `no reachable followers, nothing queued${left}`
    : 'no followers yet, nothing queued'
}

async function isDefaultLocale(strapi: Core.Strapi, event: EntryEvent): Promise<boolean> {
  const locale = event.entry?.locale
  return locale == null || locale === (await getDefaultLocale(strapi))
}

/** What `federateArticle` did. */
export type FederateOutcome =
  | { status: 'queued'; type: 'Create' | 'Update'; slug: string; fanOut: FanOut }
  | { status: 'not-federable' }

/**
 * Queues the article's current published version for the followers: a `Create` when it was never
 * sent, was retracted or its `Create` failed, an `Update` otherwise (`activityTypeFor`), because
 * publishing again is how edits go live in Strapi 5. Used by the publish event and by the admin panel's "Federate now".
 *
 * @param site - The `documentId` of the site whose followers get it; the default site when omitted.
 * @returns `not-federable` when the default locale has no published version with a title and slug.
 */
export async function federateArticle(
  strapi: Core.Strapi,
  documentId: string,
  site?: string
): Promise<FederateOutcome> {
  const record = await findPublishedArticle(strapi, documentId)
  if (record == null) return { status: 'not-federable' }

  const type = activityTypeFor(await findFederatedArticle(strapi, documentId, site))
  const ctx = createContext(strapi)
  const objectType = await getObjectType(strapi)
  const fanOut = await sendRecorded(
    strapi,
    documentId,
    type,
    buildArticleActivity(
      type === 'Create' ? 'create' : 'update',
      ctx,
      ACTOR_IDENTIFIER,
      record,
      objectType
    ),
    record.firstPublishedAt,
    site
  )
  strapi.log.info(
    `[fediverse] ${type}(${objectType === 'note' ? 'Note' : 'Article'}) for ${documentId} (${record.slug}): ${describeFanOut(fanOut)}`
  )
  return { status: 'queued', type, slug: record.slug, fanOut }
}

/** What `retryFailedDelivery` did. */
export type RetryOutcome =
  | { status: 'queued'; type: 'Create' | 'Update' | 'Delete'; fanOut: FanOut }
  | { status: 'not-failed' }
  | { status: 'not-federable' }

/**
 * Sends again the last activity of an article whose delivery was given up on.
 *
 * @remarks
 * A failed `Delete` is sent as a `Delete` again, unless the article was published since, in which
 * case the current version is what the followers should have. Anything else goes through
 * `federateArticle`, the same path as "Federate now", so it is queued like any publish and skips
 * unreachable followers. Fedify reports no success, so the row says `created`, `updated` or
 * `deleted` (queued) at once and turns `failed` again only if Fedify gives up again.
 *
 * @param site - The `documentId` of the site; the default site when omitted.
 */
export async function retryFailedDelivery(
  strapi: Core.Strapi,
  documentId: string,
  site?: string
): Promise<RetryOutcome> {
  const row = await findFederatedArticle(strapi, documentId, site)
  if (row == null || row.status !== 'failed') return { status: 'not-failed' }

  if (
    row.lastActivityType === 'Delete' &&
    (await findPublishedArticle(strapi, documentId)) == null
  ) {
    const ctx = createContext(strapi)
    const fanOut = await sendRecorded(
      strapi,
      documentId,
      'Delete',
      buildDeleteActivity(ctx, ACTOR_IDENTIFIER, documentId),
      undefined,
      site
    )
    strapi.log.info(
      `[fediverse] Delete(Article) for ${documentId} retried: ${describeFanOut(fanOut)}`
    )
    return { status: 'queued', type: 'Delete', fanOut }
  }

  const outcome = await federateArticle(strapi, documentId, site)
  return outcome.status === 'queued'
    ? { status: 'queued', type: outcome.type, fanOut: outcome.fanOut }
    : { status: 'not-federable' }
}

async function onPublish(strapi: Core.Strapi, event: EntryEvent): Promise<void> {
  const documentId = event.entry?.documentId
  if (!documentId || !(await isDefaultLocale(strapi, event))) return

  const outcome = await federateArticle(strapi, documentId)
  if (outcome.status === 'not-federable') {
    strapi.log.warn(
      `[fediverse] not federating article ${documentId}: no published default-locale version with a title and slug`
    )
  }
}

/**
 * The `fediverse` component is not localized: a save in another locale reaches the default
 * locale's row only when i18n copies it, after the event. So the actor is built a moment later.
 */
async function onSiteSettingsChanged(strapi: Core.Strapi, event: EntryEvent): Promise<void> {
  if (!(await isDefaultLocale(strapi, event))) {
    await new Promise((resolve) => setTimeout(resolve, LOCALE_SYNC_DELAY_MS))
  }
  await onProfileChanged(strapi)
}

async function onRemoved(strapi: Core.Strapi, event: EntryEvent): Promise<void> {
  const documentId = event.entry?.documentId
  if (!documentId || !(await isDefaultLocale(strapi, event))) return
  if (!(await isFederated(strapi, documentId))) return

  // Deleting a draft-only revision must not retract a version that is still live.
  if ((await findPublishedArticle(strapi, documentId)) != null) return

  const ctx = createContext(strapi)
  const fanOut = await sendRecorded(
    strapi,
    documentId,
    'Delete',
    buildDeleteActivity(ctx, ACTOR_IDENTIFIER, documentId)
  )
  strapi.log.info(`[fediverse] Delete(Article) for ${documentId}: ${describeFanOut(fanOut)}`)
}

const PROFILE_FINGERPRINT_KEY = 'profileFingerprint'

/**
 * Mastodon caches remote profiles, so a change to the `global` single type or to the site
 * settings (name, bio, avatar, header, username) only reaches followers' servers through an
 * Update(Person) carrying the new actor.
 *
 * @remarks
 * Sent only when the served actor differs from the one last sent (a fingerprint in the plugin
 * store), so saving unrelated settings, or the same profile in another locale, sends nothing.
 */
async function onProfileChanged(strapi: Core.Strapi): Promise<void> {
  const ctx = createContext(strapi)
  const actor = await buildActor(ctx, ACTOR_IDENTIFIER)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(await actor.toJsonLd()))
    .digest('hex')
  const store = strapi.store({ type: 'plugin', name: 'fediverse' })
  if ((await store.get({ key: PROFILE_FINGERPRINT_KEY })) === fingerprint) return

  const fanOut = await sendToFollowers(
    strapi,
    // `ActorUpdate`, not `Update`: Mastodon resets `attributionDomains` when the bare key is missing.
    new ActorUpdate({
      id: new URL(`#profile-update/${Date.now()}`, actor.id!),
      actor: actor.id,
      object: actor,
      to: PUBLIC_COLLECTION,
      cc: ctx.getFollowersUri(ACTOR_IDENTIFIER),
    })
  )
  await store.set({ key: PROFILE_FINGERPRINT_KEY, value: fingerprint })
  strapi.log.info(`[fediverse] Update(Person) for the profile: ${describeFanOut(fanOut)}`)
}

/**
 * Sends `Update(Person)` at boot when the served actor differs from the one last sent. Part of the
 * actor comes from variables (the `url`, the Blog field and `attributionDomains` from `FRONTEND_URL`
 * and `FEDIVERSE_HANDLE_HOST`), which change only on a restart; a release that adds a property to
 * the actor reaches followers' servers this way too. Failures are logged, never thrown: the boot
 * goes on.
 */
export async function syncProfileAtBoot(strapi: Core.Strapi): Promise<void> {
  try {
    await onProfileChanged(strapi)
  } catch (error) {
    strapi.log.error('[fediverse] profile update federation at boot failed', { error })
  }
}

/**
 * Federates article publish state changes and profile edits. Failures are logged and swallowed:
 * the events fire after the Strapi operation has committed, and federation
 * problems must never surface as editor-facing errors.
 */
export function subscribe(strapi: Core.Strapi): void {
  const guarded =
    (
      uid: string,
      label: string,
      handler: (strapi: Core.Strapi, event: EntryEvent) => Promise<void>
    ) =>
    async (event: EntryEvent): Promise<void> => {
      if (event?.uid !== uid) return
      try {
        await handler(strapi, event)
      } catch (error) {
        strapi.log.error(`[fediverse] ${label} failed`, { error })
      }
    }

  unsubscribers = [
    strapi.eventHub.on(
      'entry.publish',
      guarded(ARTICLE_UID, 'article publish federation', onPublish)
    ),
    strapi.eventHub.on(
      'entry.unpublish',
      guarded(ARTICLE_UID, 'article unpublish federation', onRemoved)
    ),
    strapi.eventHub.on(
      'entry.delete',
      guarded(ARTICLE_UID, 'article delete federation', onRemoved)
    ),
    // `global` has no draft & publish: saving it in the admin emits entry.update.
    strapi.eventHub.on(
      'entry.create',
      guarded(GLOBAL_UID, 'profile update federation', onProfileChanged)
    ),
    strapi.eventHub.on(
      'entry.update',
      guarded(GLOBAL_UID, 'profile update federation', onProfileChanged)
    ),
    // The actor's profile lives in the default site's `fediverse` component. Not filtered by locale:
    // it is not localized, so a save in `es` changes the actor but only emits the `es` event
    // (see onSiteSettingsChanged).
    // Only updates: the boot seed creates the document (one per locale), and an actor nobody has
    // cached yet has nothing to refresh. Subscribing to creates sent a delayed `Update(Person)`
    // to whoever followed right after boot.
    strapi.eventHub.on(
      'entry.update',
      guarded(SITE_UID, 'profile update federation', onSiteSettingsChanged)
    ),
  ]
}

/** Stops federating article and profile changes; called by the plugin's `destroy()`. */
export function unsubscribe(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
}
