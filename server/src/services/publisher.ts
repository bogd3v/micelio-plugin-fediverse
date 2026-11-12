import { createHash } from 'node:crypto'

import type { Core } from '@strapi/strapi'

import type { Context } from '@fedify/fedify'
import { PUBLIC_COLLECTION, type Activity } from '@fedify/fedify/vocab'

import { ActorUpdate } from '../attributed-actor'
import { ARTICLE_UID, GLOBAL_UID, SITE_UID } from '../constants/uids'
import { buildActor, getFederation } from '../federation'
import {
  buildArticleActivity,
  buildDeleteActivity,
  findPublishedArticle,
  frontendDefaultLocale,
  getDefaultLocale,
} from './articles'
import { getObjectType } from './object-type'
import { actorSiteOf, defaultIdentifier, listActorSites } from './actor-sites'
import {
  activityTypeFor,
  findFederatedArticle,
  findFederatedSites,
  isFederated,
  recordFailure,
  recordSend,
} from './federated-articles'
import { listFollowers } from './followers'
import type { FederatedActivityType } from '../types/federated-articles'
import type { FediverseContextData } from '../types/federation'

interface EntryEvent {
  uid?: string
  entry?: { documentId?: string; locale?: string | null; publishedAt?: string | null } | null
}

/** What the core's `afterPublish` and `afterUnpublish` hooks hand a handler (`docs/hooks.md` of the core). */
interface EntryHookPayload {
  /** The `documentId` of the entry's site; `null` for a type without site scope. */
  site: string | null
  type: string
  documentId: string
  locale: string | null
}

/** How long a save in a non-default locale waits for i18n to copy the shared fields. */
const LOCALE_SYNC_DELAY_MS = 1000

let unsubscribers: Array<() => void> = []
let hookUnsubscribers: Array<() => void> = []

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
  site?: string,
  identifier?: string
): Promise<FanOut> {
  const followers = await listFollowers(strapi, { site })
  const reachable = followers.filter((follower) => follower.unreachableSince == null)
  const skipped = followers.length - reachable.length
  if (reachable.length === 0 && extra.length === 0) return { queued: 0, skipped }

  const ctx = createContext(strapi)
  await ctx.sendActivity(
    { identifier: identifier ?? (await defaultIdentifier(strapi)) },
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
  return isDefault(strapi, event.entry?.locale)
}

/** Whether the locale of an event is the default one (a missing locale counts as the default). */
async function isDefault(strapi: Core.Strapi, locale: string | null | undefined): Promise<boolean> {
  return locale == null || locale === (await getDefaultLocale(strapi))
}

/** What `federateArticle` did. */
export type FederateOutcome =
  | { status: 'queued'; type: 'Create' | 'Update'; slug: string; fanOut: FanOut }
  | { status: 'not-federable' }

/**
 * Queues the article's current published version, with every published locale in its
 * `contentMap`, for the followers: a `Create` when it was never
 * sent, was retracted or its `Create` failed, an `Update` otherwise (`activityTypeFor`), because
 * publishing again is how edits go live in Strapi 5. Used by the publish event and by the admin panel's "Federate now".
 *
 * @param site - The `documentId` of the site whose followers get it; the default site when omitted.
 * @param changedAt - An ISO time that the object's `updated` is not earlier than: when the change
 * is one the published rows do not show, such as a translation unpublished.
 * @returns `not-federable` when the default locale has no published version with a title and slug
 * (the anchor: a translation alone is never federated).
 */
export async function federateArticle(
  strapi: Core.Strapi,
  documentId: string,
  site?: string,
  changedAt?: string
): Promise<FederateOutcome> {
  const found = await findPublishedArticle(strapi, documentId)
  if (found == null) return { status: 'not-federable' }
  const row = await findFederatedArticle(strapi, documentId, site)
  const type = activityTypeFor(row)
  // `updated` never goes back: a change no published row records (a translation left the map)
  // moved it to the time of its `Update`, and "Federate now" or a retry later sends the same map
  // from rows that are older than that. A receiving server drops an edit that is not newer than
  // the one it holds.
  const lastUpdateAt =
    row?.lastActivityAt != null && row.status !== 'deleted' && row.lastActivityType === 'Update'
      ? new Date(row.lastActivityAt).toISOString()
      : undefined
  const floor = [changedAt, lastUpdateAt]
    .filter((value): value is string => value != null)
    .sort()
    .pop()
  const record =
    floor != null && (found.updatedAt == null || floor > found.updatedAt)
      ? { ...found, updatedAt: floor }
      : found

  const ctx = createContext(strapi)
  const objectType = await getObjectType(strapi)
  const fanOut = await sendRecorded(
    strapi,
    documentId,
    type,
    buildArticleActivity(
      type === 'Create' ? 'create' : 'update',
      ctx,
      await defaultIdentifier(strapi),
      record,
      objectType,
      await frontendDefaultLocale(strapi)
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
      buildDeleteActivity(ctx, await defaultIdentifier(strapi), documentId),
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

/**
 * Federates the published version of an article and warns when there is nothing to federate.
 *
 * @param locale - The locale that was published. A translation published before the default
 * locale sends nothing and is no warning: it is in the map of the `Create` the default
 * locale's publish sends.
 */
async function publishArticle(
  strapi: Core.Strapi,
  documentId: string,
  site?: string,
  locale?: string | null
): Promise<void> {
  const outcome = await federateArticle(strapi, documentId, site)
  if (outcome.status === 'not-federable' && (await isDefault(strapi, locale))) {
    strapi.log.warn(
      `[fediverse] not federating article ${documentId}: no published default-locale version with a title and slug`
    )
  }
}

async function onPublish(strapi: Core.Strapi, event: EntryEvent): Promise<void> {
  const documentId = event.entry?.documentId
  if (!documentId) return
  await publishArticle(strapi, documentId, undefined, event.entry?.locale)
}

/**
 * The `fediverse` component is not localized: a save in another locale reaches the default
 * locale's row only when i18n copies it, after the event. So the actor is built a moment later.
 */
async function onSiteSettingsChanged(strapi: Core.Strapi, event: EntryEvent): Promise<void> {
  if (!(await isDefaultLocale(strapi, event))) {
    await new Promise((resolve) => setTimeout(resolve, LOCALE_SYNC_DELAY_MS))
  }
  await onProfileChanged(strapi, event.entry?.documentId)
}

/** Sends a `Delete` for an article that was federated and has no published version left. */
async function retractArticle(
  strapi: Core.Strapi,
  documentId: string,
  site?: string
): Promise<void> {
  if (!(await isFederated(strapi, documentId, site))) return

  // Deleting a draft-only revision must not retract a version that is still live.
  if ((await findPublishedArticle(strapi, documentId)) != null) return

  const ctx = createContext(strapi)
  const fanOut = await sendRecorded(
    strapi,
    documentId,
    'Delete',
    buildDeleteActivity(ctx, await defaultIdentifier(strapi), documentId),
    undefined,
    site
  )
  strapi.log.info(`[fediverse] Delete(Article) for ${documentId}: ${describeFanOut(fanOut)}`)
}

/**
 * Sends the `Update` that takes an unpublished translation out of the map, for an article that was
 * sent and whose default locale is still published; nothing otherwise (a retracted article has no
 * map to correct).
 */
async function refreshArticle(
  strapi: Core.Strapi,
  documentId: string,
  site?: string
): Promise<void> {
  if (!(await isFederated(strapi, documentId, site))) return
  await federateArticle(strapi, documentId, site, new Date().toISOString())
}

/** The retractions and refreshes in progress, by `documentId` and locale: see `onRemoved`. */
const removing = new Map<string, Promise<void>>()

/**
 * The retraction (or, for a translation, the refresh) that follows an unpublish or a delete.
 *
 * @param fromDelete - The event is `entry.delete`, which Strapi emits for the draft and for the
 * published version of an entry: a translation is refreshed on the published one only, because
 * deleting a translation that was never published leaves the map as it was.
 */
async function onRemoved(
  strapi: Core.Strapi,
  event: EntryEvent,
  fromDelete = false
): Promise<void> {
  const documentId = event.entry?.documentId
  if (!documentId) return
  const isDefaultEvent = await isDefaultLocale(strapi, event)
  if (!isDefaultEvent && fromDelete && event.entry?.publishedAt == null) return
  // Strapi emits `entry.delete` once per stored version of the document (the draft and the
  // published one), at once: the second waits for the first, whose row then says `deleted`
  // (or, for a translation, whose `Update` already leaves it out of the map).
  const key = `${documentId}:${event.entry?.locale ?? ''}`
  const running = removing.get(key)
  if (running != null) {
    await running
    return
  }
  const retraction = (async () => {
    // The event names no site, and an article of a site-scoped type was sent for its own:
    // retract it from every site that has a row for it (the default site's, for an unscoped type).
    for (const site of await findFederatedSites(strapi, documentId)) {
      // The default locale anchors the object (its `url` is that locale's address): without it
      // the article is retracted, whatever translations stay. A translation only leaves the map.
      if (isDefaultEvent) await retractArticle(strapi, documentId, site)
      else await refreshArticle(strapi, documentId, site)
    }
  })()
  removing.set(key, retraction)
  try {
    await retraction
  } finally {
    removing.delete(key)
  }
}

/**
 * Whether a content type was made with `withEditorial` of the core, which marks it in its
 * `pluginOptions`. Its entries are published and unpublished only through the core's transitions,
 * which run the hooks this plugin listens to.
 */
function hasEditorial(strapi: Core.Strapi, uid: string): boolean {
  const options = (
    strapi.contentType(uid as never) as
      { pluginOptions?: { micelio?: { editorial?: unknown } } } | undefined
  )?.pluginOptions
  return options?.micelio?.editorial === true
}

const PROFILE_FINGERPRINT_KEY = 'profileFingerprint'

/** The store key of the fingerprint of the actor last sent for a site. */
function fingerprintKey(site: string): string {
  return `${PROFILE_FINGERPRINT_KEY}:${site}`
}

/**
 * Mastodon caches remote profiles, so a change to the `global` single type or to the site
 * settings (name, bio, avatar, header, username) only reaches followers' servers through an
 * Update(Person) carrying the new actor.
 *
 * @remarks
 * Sent only when the served actor differs from the one last sent (a fingerprint in the plugin
 * store, one per site), so saving unrelated settings, or the same profile in another locale,
 * sends nothing. The `hosts` of the site are part of the actor (`attributionDomains`), so a change
 * of them sends it too.
 *
 * @param site - The site's `documentId`; the default site when omitted.
 */
async function onProfileChanged(strapi: Core.Strapi, site?: string): Promise<void> {
  // One at a time per site, each reading the actor when its turn comes: the events of a burst of
  // saves (each emits one) then send the latest actor once, not one `Update(Person)` per save, and
  // an older actor cannot overwrite the fingerprint of a newer one.
  const key = site ?? ''
  const previous = profileTurns.get(key)
  let release = (): void => undefined
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  profileTurns.set(key, mine)
  await previous
  try {
    await sendProfileUpdate(strapi, site)
  } finally {
    release()
    if (profileTurns.get(key) === mine) profileTurns.delete(key)
  }
}

/** The `onProfileChanged` calls waiting their turn, by site (`''` for the default site). */
const profileTurns = new Map<string, Promise<void>>()

async function sendProfileUpdate(strapi: Core.Strapi, site?: string): Promise<void> {
  const actorSite = site
    ? await actorSiteOf(strapi, site)
    : (await listActorSites(strapi)).find((candidate) => candidate.isDefault)
  if (actorSite?.identifier == null) return
  const ctx = createContext(strapi)
  const actor = await buildActor(ctx, actorSite.identifier)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(await actor.toJsonLd()))
    .digest('hex')
  const store = strapi.store({ type: 'plugin', name: 'fediverse' })
  if ((await store.get({ key: fingerprintKey(actorSite.documentId) })) === fingerprint) return

  const fanOut = await sendToFollowers(
    strapi,
    // `ActorUpdate`, not `Update`: Mastodon resets `attributionDomains` when the bare key is missing.
    new ActorUpdate({
      id: new URL(`#profile-update/${Date.now()}`, actor.id!),
      actor: actor.id,
      object: actor,
      to: PUBLIC_COLLECTION,
      cc: ctx.getFollowersUri(actorSite.identifier),
    }),
    [],
    actorSite.documentId,
    actorSite.identifier
  )
  await store.set({ key: fingerprintKey(actorSite.documentId), value: fingerprint })
  strapi.log.info(`[fediverse] Update(Person) for the profile: ${describeFanOut(fanOut)}`)
}

/** The `global` single type gives every actor its avatar and name fallbacks: each one is checked. */
async function onGlobalChanged(strapi: Core.Strapi): Promise<void> {
  for (const site of await listActorSites(strapi)) {
    if (site.identifier != null) await onProfileChanged(strapi, site.documentId)
  }
}

/**
 * Sends `Update(Person)` at boot, for each site that has an actor, when the served actor differs
 * from the one last sent. Part of the actor comes from variables (the `url` and the Blog field from
 * `FRONTEND_URL`), which change only on a restart; a release that adds a property to the actor
 * reaches followers' servers this way too. Failures are logged, never thrown: the boot goes on.
 */
export async function syncProfileAtBoot(strapi: Core.Strapi): Promise<void> {
  try {
    await onGlobalChanged(strapi)
  } catch (error) {
    strapi.log.error('[fediverse] profile update federation at boot failed', { error })
  }
}

/**
 * Federates the articles of the core's editorial workflow from its `afterPublish` and
 * `afterUnpublish` hooks (ADR-0017, section 5), keyed by the site of the payload.
 *
 * @remarks
 * Called from `register()`: the core's `hooks` service exists from the start, whatever the order
 * of the plugins. `afterPublish` also fires for a republish (`published → published`); that is an
 * `Update`, because `federateArticle` decides `Create` or `Update` from the article's row, so
 * running it again for the same `documentId` and `locale` leaves one row. A type without the
 * `editorial` component never reaches these hooks and is federated from `strapi.eventHub`
 * instead (see `subscribe`). A handler that throws is logged and swallowed, so it cannot undo the
 * publish, as in `subscribe`.
 */
export function subscribeHooks(strapi: Core.Strapi): void {
  const hooks = strapi.plugin('micelio').service('hooks')
  const guarded =
    (label: string, handler: (strapi: Core.Strapi, payload: EntryHookPayload) => Promise<void>) =>
    async (payload: EntryHookPayload): Promise<void> => {
      // The core fires these hooks only for a type made with `withEditorial`; checked here too, so
      // the one-trigger-per-type rule does not rest on that alone (see `subscribe`).
      if (payload?.type !== ARTICLE_UID || !hasEditorial(strapi, payload.type)) return
      try {
        await handler(strapi, payload)
      } catch (error) {
        strapi.log.error(`[fediverse] ${label} failed`, { error })
      }
    }

  hookUnsubscribers = [
    hooks.on(
      'afterPublish',
      guarded('afterPublish federation', (s, { documentId, site, locale }) =>
        publishArticle(s, documentId, site ?? undefined, locale)
      )
    ),
    hooks.on(
      'afterUnpublish',
      guarded('afterUnpublish federation', async (s, { documentId, site, locale }) =>
        (await isDefault(s, locale))
          ? retractArticle(s, documentId, site ?? undefined)
          : refreshArticle(s, documentId, site ?? undefined)
      )
    ),
  ]
}

/** Stops federating from the core's hooks; called by the plugin's `destroy()`. */
export function unsubscribeHooks(): void {
  for (const off of hookUnsubscribers) off()
  hookUnsubscribers = []
}

/**
 * Federates article publish state changes and profile edits. Failures are logged and swallowed:
 * the events fire after the Strapi operation has committed, and federation
 * problems must never surface as editor-facing errors.
 *
 * @remarks
 * `entry.publish` and `entry.unpublish` are listened to for a type without the `editorial`
 * component only: one made with `withEditorial` is federated from the core's hooks
 * (`subscribeHooks`), so an article has exactly one trigger. `entry.delete` is listened to for
 * every type, because the hooks have no delete.
 */
export function subscribe(strapi: Core.Strapi): void {
  const guarded =
    (
      uid: string,
      label: string,
      handler: (strapi: Core.Strapi, event: EntryEvent) => Promise<void>,
      { withoutEditorial = false }: { withoutEditorial?: boolean } = {}
    ) =>
    async (event: EntryEvent): Promise<void> => {
      if (event?.uid !== uid) return
      if (withoutEditorial && hasEditorial(strapi, uid)) return
      try {
        await handler(strapi, event)
      } catch (error) {
        strapi.log.error(`[fediverse] ${label} failed`, { error })
      }
    }

  unsubscribers = [
    strapi.eventHub.on(
      'entry.publish',
      guarded(ARTICLE_UID, 'article publish federation', onPublish, { withoutEditorial: true })
    ),
    strapi.eventHub.on(
      'entry.unpublish',
      guarded(ARTICLE_UID, 'article unpublish federation', onRemoved, { withoutEditorial: true })
    ),
    strapi.eventHub.on(
      'entry.delete',
      guarded(ARTICLE_UID, 'article delete federation', (s, event) => onRemoved(s, event, true))
    ),
    // `global` has no draft & publish: saving it in the admin emits entry.update.
    strapi.eventHub.on(
      'entry.create',
      guarded(GLOBAL_UID, 'profile update federation', onGlobalChanged)
    ),
    strapi.eventHub.on(
      'entry.update',
      guarded(GLOBAL_UID, 'profile update federation', onGlobalChanged)
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
