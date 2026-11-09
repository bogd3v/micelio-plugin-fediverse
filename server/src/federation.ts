import { setTimeout as pause } from 'node:timers/promises'

import type { Core } from '@strapi/strapi'

import {
  createExponentialBackoffPolicy,
  createFederation,
  SendActivityError,
  type Context,
  type Federation,
  type InboxContext,
  type InboxListener,
  type InboxListenerSetters,
  type RetryPolicy,
} from '@fedify/fedify'
import {
  Accept,
  Announce,
  Article,
  Block,
  Create,
  Delete,
  Follow,
  Image,
  Like,
  Link,
  Note,
  Object as ApObject,
  type Person,
  PropertyValue,
  Undo,
  Update,
} from '@fedify/fedify/vocab'
import {
  getActorHandle,
  isActor,
  PUBLIC_COLLECTION,
  type Activity,
  type Actor,
  type DocumentLoader,
} from '@fedify/fedify/vocab'
import { createMiddleware } from '@fedify/koa'
import type { Context as KoaContext } from 'koa'

import pkg from '../../package.json'
import { AttributedPerson } from './attributed-actor'
import { ACTOR_IDENTIFIER } from './constants/actor'
import {
  ACTOR_PATH,
  ARTICLE_PATH,
  FEDERATION_PREFIXES,
  FOLLOWERS_PATH,
  INBOX_PATH,
  NODEINFO_PATH,
  NOTE_PATH,
  OUTBOX_PATH,
  SHARED_INBOX_PATH,
} from './constants/paths'
import { ARTICLE_UID } from './constants/uids'
import { QUEUE_STOP_TIMEOUT_MS } from './constants/queue'
import type { RequestGuard, RequestGuardKind } from './types/request-guard'
import { logInboxSignatureRefused } from './utils/security-log'
import {
  buildArticle,
  buildArticleActivity,
  findPublishedArticle,
  listPublishedArticles,
} from './services/articles'
import { resolveArticleId } from './services/articles'
import { getObjectType } from './services/object-type'
import { getActorProfile, getActorUsernames } from './services/actor-profile'
import { configuredEncryptionKey, getActorKeyPairs } from './services/keys'
import { recordInteraction, removeInteraction } from './services/interactions'
import { removeReply, updateReply } from './services/replies'
import { ingestReplyThread } from './services/reply-threads'
import { settleDelivery } from './services/delivery-outcomes'
import { recordInboxRefusal } from './services/inbox-refusals'
import { buildNote, findServedReply } from './services/reply-notes'
import {
  countFollowers,
  isActorBlocked,
  listFollowers,
  markReachable,
  recordFollower,
  removeFollower,
} from './services/followers'
import type { ActorProfileField } from './types/actor-profile'
import type { FederationBackend, FediverseContextData, FederationSetup } from './types/federation'
import type { InteractionType } from './types/interactions'
import type { FetchedNote, RemoteAuthor, ReplyContext, ThreadFetcher } from './types/replies'
import { untilAborted } from './utils/abortable'
import { escapeHtml } from './utils/html'
import { createFederationBackend } from './utils/federation-backend'
import { ActorKeyDecryptionError } from './utils/key-encryption'
import { currentObservation, ObservedMessageQueue } from './utils/observed-queue'
import { federationOrigin } from './utils/handle-host'
import { FEDERATION_SECURITY_HEADERS } from './utils/security-headers'
import { inboxDigestRefusal } from './inbox-digest'
import { describeDeliveryError } from './utils/delivery-error'
import { cleanRemoteText } from './utils/remote-text'
import { safeRemoteUrl } from './utils/remote-url'

const OUTBOX_PAGE_SIZE = 20
/** Largest outbox cursor (an offset) served; a larger one is clamped, never sent to the database. */
const OUTBOX_MAX_CURSOR = 100_000
/**
 * Longest avatar URL stored. Both columns that hold it (`follower.avatar`, `comment.authorAvatar`) are
 * Strapi `string`s, 255 characters: a longer value would make the comment write fail and lose the reply.
 */
const AVATAR_MAX_LENGTH = 255
/** Shortest gap between two repeats of the guard, digest and key pairs warnings. */
const WARNING_INTERVAL_MS = 60_000
/**
 * Whether `line` may be logged now: not within `WARNING_INTERVAL_MS` of its last
 * time in `lastLogged`. Records the time when it may, and empties the map if it
 * reached `maxLines`, so a stream of distinct lines cannot grow it.
 */
function mayLog(lastLogged: Map<string, number>, line: string, maxLines: number): boolean {
  const now = Date.now()
  if (now - (lastLogged.get(line) ?? -Infinity) < WARNING_INTERVAL_MS) return false
  if (lastLogged.size >= maxLines) lastLogged.clear()
  lastLogged.set(line, now)
  return true
}

/**
 * Distinct key pairs failure lines kept for throttling. The lines come from a
 * fixed set (decryption messages and error names), so this only guards memory.
 */
const KEY_PAIRS_FAILURE_LINES_MAX = 32
/**
 * When each key pairs failure line was last logged by this process. Every actor,
 * WebFinger and signed request fails the same way until the key is fixed, so a
 * line is repeated at most once per `WARNING_INTERVAL_MS`, not once per request;
 * a failure that clears (a database outage) and comes back is logged again.
 */
const lastKeyPairsFailureLog = new Map<string, number>()

/**
 * Logs why the actor key pairs could not be loaded, each distinct line at most
 * once per `WARNING_INTERVAL_MS`. Only `ActorKeyDecryptionError` messages are
 * logged in full: any other error is reduced to its name, with no stack, so
 * nothing read from the stored key can reach the log.
 */
function logKeyPairsFailure(strapi: Core.Strapi, error: unknown): void {
  const line =
    error instanceof ActorKeyDecryptionError
      ? error.message
      : `[fediverse] the actor key pairs could not be loaded (${error instanceof Error ? error.name : 'unknown error'})`
  if (!mayLog(lastKeyPairsFailureLog, line, KEY_PAIRS_FAILURE_LINES_MAX)) return
  strapi.log.error(`${line} Repeats are held back for a minute.`)
}

/** Distinct delivery failure lines kept for throttling; the map is emptied when it is full. */
const DELIVERY_FAILURE_LINES_MAX = 64
/** When each delivery failure line was last logged by this process. */
const lastDeliveryFailureLog = new Map<string, number>()

/**
 * Logs a failed delivery attempt, each distinct activity and reason at most once per
 * `WARNING_INTERVAL_MS`. A dead server fails once per follower and retry, so an
 * unthrottled line would fill the log. Only the HTTP status or the error's name
 * is written, never the remote server's answer, which is untrusted text.
 */
function logDeliveryFailure(log: Logger, error: Error, activityId: string | undefined): void {
  const reason = error instanceof SendActivityError ? `HTTP ${error.statusCode}` : error.name
  const line = `[fediverse] delivery of ${activityId ?? '(unknown activity)'} failed (${reason}); Fedify retries it with backoff. Repeats are held back for a minute.`
  if (mayLog(lastDeliveryFailureLog, line, DELIVERY_FAILURE_LINES_MAX)) log.error(line)
}

/** When a dropped, undecryptable queued delivery was last logged. */
const lastUnreadableLog = new Map<string, number>()

/** The actor has no usable key pair; the cause is logged by `logKeyPairsFailure`. */
class ActorKeyUnavailableError extends Error {
  constructor() {
    super('[fediverse] the actor has no usable key pair')
    this.name = 'ActorKeyUnavailableError'
  }
}

/** Whether `error` comes from an actor key that cannot be loaded; the cause is logged by `logKeyPairsFailure`. */
function isActorKeyFailure(error: unknown): boolean {
  return error instanceof ActorKeyUnavailableError || error instanceof ActorKeyDecryptionError
}

/**
 * Extracts the avatar image URL from a remote actor's icon (Mastodon sends
 * an embedded Image with a url). Anything but an absolute http(s) URL of at
 * most `AVATAR_MAX_LENGTH` characters gives `null`, see `safeRemoteUrl`.
 */
async function extractAvatarUrl(
  strapi: Core.Strapi,
  actor: Actor | null,
  documentLoader: DocumentLoader
): Promise<string | null> {
  if (actor == null) return null
  try {
    const icon = await actor.getIcon({ documentLoader, suppressError: true })
    if (icon == null) return null
    const url = icon.url instanceof Link ? icon.url.href : icon.url
    return safeRemoteUrl(url, AVATAR_MAX_LENGTH)
  } catch (error) {
    strapi.log.warn('[fediverse] failed to extract follower avatar', { error })
    return null
  }
}

/** What reply handling needs, with the blog's usernames as the default site has them now. */
async function loadReplyContext(ctx: Context<FediverseContextData>): Promise<ReplyContext> {
  return { ...replyContext(ctx), actorUsernames: await getActorUsernames(ctx.data.strapi) }
}

function replyContext(ctx: {
  parseUri(uri: URL): { type: string; class?: unknown; values?: Record<string, string> } | null
}): ReplyContext {
  return {
    actorUsernames: [],
    parseArticleUri(uri) {
      try {
        const parsed = ctx.parseUri(new URL(uri))
        return parsed?.type === 'object' && parsed.class === Article
          ? (parsed.values?.documentId ?? null)
          : null
      } catch {
        return null
      }
    },
  }
}

async function describeRemoteActor(
  strapi: Core.Strapi,
  actor: Actor | null,
  fallbackId: URL,
  documentLoader: DocumentLoader
) {
  let handle: string | null = null
  try {
    handle = cleanRemoteText(await getActorHandle(actor ?? fallbackId))
  } catch {
    handle = null
  }
  const name = cleanRemoteText(actor?.name) || cleanRemoteText(actor?.preferredUsername) || handle
  return { handle, name, avatar: await extractAvatarUrl(strapi, actor, documentLoader) }
}

/** Whether a note is addressed to the public: only those may become comments on a public site. */
function isPublicNote(note: Note): boolean {
  return [...note.toIds, ...note.ccIds].some((id) => id.href === PUBLIC_COLLECTION.href)
}

/**
 * How reply ingestion fetches the notes above a reply and their authors: with
 * the blog's signed document loader (servers that require authorized fetch
 * answer it), bounded by the caller's signal.
 */
function threadFetcher(ctx: InboxContext<FediverseContextData>): ThreadFetcher {
  const strapi = ctx.data.strapi
  let signed: Promise<DocumentLoader> | undefined
  const loaderFor = async (signal: AbortSignal): Promise<DocumentLoader> => {
    signed ??= ctx.getDocumentLoader({ identifier: ACTOR_IDENTIFIER })
    const loader = await signed
    return (url, options) => loader(url, { ...options, signal })
  }

  return {
    async fetchNote(uri, signal): Promise<FetchedNote | null> {
      let url: URL
      try {
        url = new URL(uri)
      } catch {
        return null
      }
      // Our own ids that matched nothing stored are not fetched back from ourselves.
      if (!['http:', 'https:'].includes(url.protocol) || ctx.parseUri(url) != null) return null

      let note: unknown
      try {
        // Loaded directly, not through `lookupObject`: that falls back to an unsigned
        // WebFinger lookup when the fetch fails, which could hand back another host's note.
        const documentLoader = await loaderFor(signal)
        const { document, documentUrl } = await documentLoader(url.href)
        if (new URL(documentUrl).origin !== url.origin) return null
        note = await ApObject.fromJsonLd(document, {
          documentLoader,
          contextLoader: ctx.contextLoader,
        })
      } catch (error) {
        strapi.log.debug(
          `[fediverse] could not fetch ${url.href}: ${error instanceof Error ? error.message : 'unknown error'}`
        )
        return null
      }
      if (!(note instanceof Note) || note.id == null || note.attributionId == null) return null
      // The note's server vouches only for its own ids and actors, as the signature
      // does for a delivered note; a redirect to another host is refused above.
      if (note.id.origin !== url.origin || note.attributionId.origin !== url.origin) return null
      if (!isPublicNote(note)) return null

      return {
        uri: note.id.href,
        inReplyTo: note.replyTargetId?.href ?? null,
        contentHtml: String(note.content ?? ''),
        actorId: note.attributionId.href,
      }
    },

    async describeAuthor(actorId, signal): Promise<RemoteAuthor> {
      try {
        const documentLoader = await loaderFor(signal)
        const actor = await ctx.lookupObject(actorId, { documentLoader, signal })
        return await untilAborted(
          describeRemoteActor(
            strapi,
            isActor(actor) ? actor : null,
            new URL(actorId),
            documentLoader
          ),
          signal
        )
      } catch {
        // Out of time or unreachable: the comment is stored with the actor id as its author name.
        return { handle: null, name: null, avatar: null }
      }
    },
  }
}

/**
 * Records a `Like`/`Announce` of one of our articles. Anything else — other
 * servers' posts, unpublished articles, blocked actors — is ignored.
 */
async function receiveInteraction(
  type: InteractionType,
  ctx: InboxContext<FediverseContextData>,
  activity: Like | Announce
): Promise<void> {
  const strapi = ctx.data.strapi
  if (activity.actorId == null || activity.objectId == null) return

  const articleDocumentId = await resolveArticleId(
    strapi,
    activity.objectId.href,
    replyContext(ctx).parseArticleUri
  )
  if (!articleDocumentId) return
  if ((await findPublishedArticle(strapi, articleDocumentId)) == null) return
  if (await isActorBlocked(strapi, activity.actorId.href)) return

  const actor = await activity.getActor({
    documentLoader: ctx.documentLoader,
    suppressError: true,
  })
  let handle: string | null = null
  try {
    handle = cleanRemoteText(await getActorHandle((actor as Actor | null) ?? activity.actorId))
  } catch {
    handle = null
  }

  const result = await recordInteraction(strapi, {
    type,
    actorId: activity.actorId.href,
    handle,
    articleDocumentId,
  })
  if (result === 'created') {
    strapi.log.info(
      `[fediverse] ${type} from ${handle ?? activity.actorId.href} on ${articleDocumentId}`
    )
  }
}

type Logger = Pick<Core.Strapi['log'], 'error'>

/** Mastodon renders a PropertyValue's value as HTML, so the URL becomes a link. */
function profileField(field: ActorProfileField): PropertyValue {
  const href = escapeHtml(field.url)
  const label = escapeHtml(field.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))
  return new PropertyValue({
    name: field.name,
    value: `<a href="${href}" rel="me nofollow noopener" target="_blank">${label}</a>`,
  })
}

/**
 * The blog actor, as served by the actor dispatcher and embedded in the
 * `Update(Person)` sent when the profile changes. Profile data comes from the
 * `global` single type (see services/actor-profile.ts); `attributionDomains`
 * goes through `AttributedPerson`, since Fedify's `Person` has no such property.
 */
export async function buildActor(
  ctx: Context<FediverseContextData>,
  identifier: string
): Promise<Person> {
  const actorUri = ctx.getActorUri(identifier)
  const profile = await getActorProfile(ctx.data.strapi, actorUri.href)
  const keyPairs = await ctx.getActorKeyPairs(identifier)
  // Fedify turns a failing key pairs dispatcher into no keys; an actor served
  // without its key would look like a new identity to remote servers.
  // Fedify signs HTTP requests with the first RSASSA-PKCS1-v1_5 pair, so
  // `publicKey` must be that one whatever the order of the stored pairs.
  const httpSignatureKey = keyPairs.find(
    (keyPair) => keyPair.privateKey.algorithm.name === 'RSASSA-PKCS1-v1_5'
  )
  if (httpSignatureKey == null) throw new ActorKeyUnavailableError()

  return new AttributedPerson({
    id: actorUri,
    preferredUsername: identifier === ACTOR_IDENTIFIER ? profile.username : identifier,
    name: profile.name,
    summary: profile.summary ?? undefined,
    url: new URL(profile.url),
    inbox: ctx.getInboxUri(identifier),
    followers: ctx.getFollowersUri(identifier),
    outbox: ctx.getOutboxUri(identifier),
    discoverable: profile.discoverable,
    manuallyApprovesFollowers: false,
    icon: profile.iconUrl ? new Image({ url: new URL(profile.iconUrl) }) : undefined,
    image: profile.headerUrl ? new Image({ url: new URL(profile.headerUrl) }) : undefined,
    attachments: profile.fields.map(profileField),
    publicKey: httpSignatureKey.cryptographicKey,
    assertionMethods: keyPairs.map((keyPair) => keyPair.multikey),
    attributionDomains: profile.attributionDomains,
  })
}

/**
 * Wraps an inbox listener so that any activity from a follower flagged
 * unreachable first clears the flag: the follower's server answers again.
 */
function heardFrom<TActivity extends Activity>(
  listener: InboxListener<FediverseContextData, TActivity>
): InboxListener<FediverseContextData, TActivity> {
  return async (ctx, activity) => {
    const { strapi } = ctx.data
    if (activity.actorId != null) {
      try {
        const cleared = await markReachable(strapi, activity.actorId.href)
        if (cleared > 0) strapi.log.info(`[fediverse] ${activity.actorId.href} is reachable again`)
      } catch (error) {
        strapi.log.warn(
          `[fediverse] could not clear the unreachable flag: ${error instanceof Error ? error.name : 'unknown error'}`
        )
      }
    }
    await listener(ctx, activity)
  }
}

/**
 * Makes every listener registered on `setters` clear the sender's unreachable flag first,
 * so no listener has to remember to. `on` keeps returning the same object, so the
 * chain of registrations reads as before.
 */
function heardFromListeners(
  setters: InboxListenerSetters<FediverseContextData>
): InboxListenerSetters<FediverseContextData> {
  const register = setters.on.bind(setters) as typeof setters.on
  setters.on = ((type, listener) => register(type, heardFrom(listener))) as typeof setters.on
  return setters
}

/**
 * Builds the Fedify `Federation` of the blog actor, with every dispatcher and
 * inbox listener registered.
 *
 * @remarks
 * Outgoing activities go through `setup.backend`'s queue, so publishing returns
 * once they are enqueued and a failed delivery is retried with Fedify's default
 * backoff (`setup.retryPolicy` can replace it, for tests). The queue is not
 * started here: `startFederationQueue` does it at bootstrap, so messages left
 * by a previous run are picked up even before the first request. `getFederation`
 * keeps one per Strapi instance.
 */
export function createFediverseFederation(
  setup: FederationSetup
): Federation<FediverseContextData> {
  const { log, origin, backend } = setup
  const queue = new ObservedMessageQueue(backend.queue, {
    encryptionKey: setup.encryptionKey,
    settle: setup.settle,
    onUnreadable: setup.onUnreadable,
  })
  const defaultRetryPolicy = createExponentialBackoffPolicy()
  const federation = createFederation<FediverseContextData>({
    kv: backend.kv,
    // Outgoing only: incoming activities are still handled while the request is open.
    queue: { outbox: queue, fanout: queue },
    manuallyStartQueue: true,
    ...(origin ? { origin } : {}),
    outboxRetryPolicy: (context) => {
      const delay = (setup.retryPolicy?.() ?? defaultRetryPolicy)(context)
      const observation = currentObservation()
      if (observation) observation.retry = delay
      return delay
    },
    // Called for every failed attempt, retries included. Fedify's own LogTape line for
    // it does not name the activity; this one does, so a rejected delivery (e.g.
    // Mastodon answering 401/422) can be traced to the article.
    onOutboxError: (error, activity) => {
      const observation = currentObservation()
      if (observation) observation.failure = { error, activity }
      if (log) logDeliveryFailure(log, error, activity?.id?.href)
    },
    // Lets tests dereference a fake remote actor served from 127.0.0.1 (real
    // remotes are always public hosts). Never true outside NODE_ENV=test.
    allowPrivateAddress: process.env.NODE_ENV === 'test',
  })

  // Only a 404 or 410 from the inbox, or a held activity that expired: Fedify does not retry it.
  federation.setOutboxPermanentFailureHandler((_ctx, values) => {
    const observation = currentObservation()
    if (observation) observation.permanent = { reason: values.reason, error: values.error }
  })

  federation
    .setActorDispatcher(ACTOR_PATH, async (ctx, identifier) => {
      if (identifier !== ACTOR_IDENTIFIER) return null
      return buildActor(ctx, identifier)
    })
    .mapHandle(async (ctx, username) =>
      (await getActorUsernames(ctx.data.strapi)).includes(username.toLowerCase())
        ? ACTOR_IDENTIFIER
        : null
    )
    .setKeyPairsDispatcher(async (context, identifier) => {
      if (identifier !== ACTOR_IDENTIFIER) return []
      // Keys are persisted as JWKs in the plugin store; Fedify derives the
      // key ids (`#main-key`) from the current request origin. Fedify logs a
      // dispatcher error only as "no dispatcher registered", so log the cause.
      try {
        return await getActorKeyPairs(context.data.strapi)
      } catch (error) {
        logKeyPairsFailure(context.data.strapi, error)
        throw error
      }
    })

  federation
    .setFollowersDispatcher(FOLLOWERS_PATH, async (ctx, identifier, cursor) => {
      if (identifier !== ACTOR_IDENTIFIER) return null
      // Single page: all non-blocked followers, no pagination cursor.
      if (cursor != null) return { items: [] }

      const followers = await listFollowers(ctx.data.strapi)
      return {
        items: followers.map((follower) => ({
          id: new URL(follower.actorId),
          inboxId: follower.inbox ? new URL(follower.inbox) : null,
        })),
      }
    })
    .setCounter(async (ctx, identifier) => {
      if (identifier !== ACTOR_IDENTIFIER) return null
      return await countFollowers(ctx.data.strapi)
    })

  // A moderator's reply: served only while it is shown (a removed one is a 404, as its Tombstone says).
  federation.setObjectDispatcher(Note, NOTE_PATH, async (ctx, values) => {
    const served = await findServedReply(ctx.data.strapi, values.documentId)
    return served == null ? null : buildNote(ctx, ACTOR_IDENTIFIER, served.comment, served.target)
  })

  // Keyed by `Article` for the route and the id; the object is a `Note` when the site chose that.
  federation.setObjectDispatcher<ApObject, 'documentId'>(
    Article,
    ARTICLE_PATH,
    async (ctx, values) => {
      const record = await findPublishedArticle(ctx.data.strapi, values.documentId)
      if (record == null) return null
      return buildArticle(ctx, ACTOR_IDENTIFIER, record, await getObjectType(ctx.data.strapi))
    }
  )

  federation
    .setOutboxDispatcher(OUTBOX_PATH, async (ctx, identifier, cursor) => {
      if (identifier !== ACTOR_IDENTIFIER) return null

      const start = Math.min(
        Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0),
        OUTBOX_MAX_CURSOR
      )
      const { items, total } = await listPublishedArticles(ctx.data.strapi, {
        start,
        limit: OUTBOX_PAGE_SIZE,
      })
      const next = start + OUTBOX_PAGE_SIZE
      const objectType = await getObjectType(ctx.data.strapi)
      return {
        items: items.map((record) =>
          buildArticleActivity('create', ctx, identifier, record, objectType)
        ),
        nextCursor: next < total ? String(next) : null,
      }
    })
    .setCounter(async (ctx, identifier) => {
      if (identifier !== ACTOR_IDENTIFIER) return null
      const { total } = await listPublishedArticles(ctx.data.strapi, { start: 0, limit: 1 })
      return total
    })
    .setFirstCursor(async () => '0')

  federation.setNodeInfoDispatcher(NODEINFO_PATH, async (ctx) => {
    const strapi = ctx.data.strapi

    let localPosts = 0
    try {
      localPosts = await strapi.documents(ARTICLE_UID).count({ status: 'published' })
    } catch (error) {
      strapi.log.warn('[fediverse] failed to count published articles for NodeInfo', { error })
    }

    return {
      software: {
        name: 'micelio-cms',
        version: pkg.version,
      },
      protocols: ['activitypub'],
      openRegistrations: false,
      usage: {
        users: { total: 1 },
        localPosts,
        localComments: 0,
      },
    }
  })

  // Every inbox listener below clears the sender's unreachable flag first (`heardFrom`).
  const setInboxListeners = federation.setInboxListeners.bind(federation)
  federation.setInboxListeners = (...args: Parameters<typeof setInboxListeners>) =>
    heardFromListeners(setInboxListeners(...args))

  federation
    .setInboxListeners(INBOX_PATH, SHARED_INBOX_PATH)
    .on(Follow, async (ctx, follow) => {
      const strapi = ctx.data.strapi
      const actorId = follow.actorId
      if (actorId == null) return

      // Only accept follows addressed to the blog actor (relevant for the
      // shared inbox, which receives activities for any recipient).
      const targetId = follow.objectId?.href
      if (targetId !== ctx.getActorUri(ACTOR_IDENTIFIER).href) {
        strapi.log.warn(`[fediverse] ignoring Follow addressed at ${targetId ?? '(none)'}`)
        return
      }

      // Dereference the remote actor for display data (name, inbox, icon).
      let remoteActor: Actor | null = null
      try {
        remoteActor = (await ctx.lookupObject(actorId)) as Actor | null
      } catch (error) {
        strapi.log.warn(`[fediverse] failed to look up follower actor ${actorId.href}`, { error })
      }

      let handle: string | null = null
      try {
        handle = cleanRemoteText(await getActorHandle(remoteActor ?? actorId))
      } catch {
        handle = null
      }

      const name =
        cleanRemoteText(remoteActor?.name) ??
        cleanRemoteText(remoteActor?.preferredUsername) ??
        handle

      const avatar = await extractAvatarUrl(strapi, remoteActor, ctx.documentLoader)

      const follower = await recordFollower(strapi, {
        actorId: actorId.href,
        handle,
        name,
        inbox: remoteActor?.inboxId?.href ?? null,
        avatar,
      })

      // A blocked actor gets no answer at all: an Accept would show the follow as
      // accepted on its server, and a Reject would tell it that it is blocked.
      if (follower.blocked) return

      if (remoteActor == null || remoteActor.inboxId == null) {
        // Without the remote actor's inbox we cannot deliver a signed Accept;
        // the follow is recorded, and the remote side keeps it as pending.
        strapi.log.error(
          `[fediverse] could not resolve an inbox for ${actorId.href}; recorded follow without Accept`
        )
        return
      }

      // Answer with a signed Accept so the remote server completes the follow.
      await ctx.sendActivity(
        { identifier: ACTOR_IDENTIFIER },
        remoteActor,
        new Accept({
          actor: ctx.getActorUri(ACTOR_IDENTIFIER),
          object: follow,
          to: actorId,
        })
      )

      strapi.log.info(`[fediverse] follow accepted: ${handle ?? actorId.href}`)
    })
    .on(Undo, async (ctx, undo) => {
      const strapi = ctx.data.strapi
      if (undo.actorId == null) return

      // The Undo embeds the original activity. Only the *outer* actor is covered
      // by the verified HTTP signature, so the embedded one must match it —
      // otherwise any server could undo somebody else's follow or like.
      const undone = await undo.getObject({
        documentLoader: ctx.documentLoader,
        suppressError: true,
      })
      if (undone instanceof Follow || undone instanceof Like || undone instanceof Announce) {
        if (undone.actorId?.href !== undo.actorId.href) {
          strapi.log.warn(
            `[fediverse] ignoring Undo from ${undo.actorId.href}: embedded activity belongs to ${undone.actorId?.href ?? 'nobody'}`
          )
          return
        }
      }

      if (undone instanceof Follow) {
        const removed = await removeFollower(strapi, undone.actorId!.href)
        if (removed) {
          strapi.log.info(`[fediverse] unfollowed: ${undone.actorId!.href}`)
        }
        return
      }

      if (undone instanceof Like || undone instanceof Announce) {
        const type: InteractionType = undone instanceof Like ? 'like' : 'boost'
        if (undone.objectId == null) return
        const articleDocumentId = await resolveArticleId(
          strapi,
          undone.objectId.href,
          replyContext(ctx).parseArticleUri
        )
        if (!articleDocumentId) return

        const removed = await removeInteraction(strapi, {
          type,
          actorId: undo.actorId.href,
          articleDocumentId,
        })
        if (removed) {
          strapi.log.info(
            `[fediverse] ${type} withdrawn by ${undo.actorId.href} on ${articleDocumentId}`
          )
        }
        return
      }

      strapi.log.warn(
        `[fediverse] ignoring Undo whose object is not an embedded Follow, Like or Announce (${undo.objectId?.href ?? 'no object id'})`
      )
    })
    .on(Like, (ctx, like) => receiveInteraction('like', ctx, like))
    .on(Announce, (ctx, announce) => receiveInteraction('boost', ctx, announce))
    .on(Block, async (ctx, block) => {
      const strapi = ctx.data.strapi
      if (block.actorId == null) return

      // A remote actor blocking us implies they no longer follow us.
      const removed = await removeFollower(strapi, block.actorId.href)
      if (removed) {
        strapi.log.info(`[fediverse] removed follower after Block from ${block.actorId.href}`)
      }
    })
    .on(Create, async (ctx, create) => {
      const strapi = ctx.data.strapi
      const note = await create.getObject({
        documentLoader: ctx.documentLoader,
        suppressError: true,
      })
      if (!(note instanceof Note) || note.id == null || create.actorId == null) return

      // The activity is signature-verified for `create.actor`; a Note claiming a
      // different author would let one server post as another.
      if (note.attributionId?.href !== create.actorId.href) {
        strapi.log.warn(`[fediverse] ignoring Note ${note.id.href}: author does not match sender`)
        return
      }
      if (note.replyTargetId == null) return

      const actor = await create.getActor({
        documentLoader: ctx.documentLoader,
        suppressError: true,
      })
      const remote = await describeRemoteActor(
        strapi,
        actor as Actor | null,
        create.actorId,
        ctx.documentLoader
      )

      const result = await ingestReplyThread(
        strapi,
        {
          uri: note.id.href,
          inReplyTo: note.replyTargetId.href,
          contentHtml: String(note.content ?? ''),
          actorId: create.actorId.href,
          ...remote,
        },
        await loadReplyContext(ctx),
        threadFetcher(ctx)
      )
      if (result.status === 'applied') {
        strapi.log.info(
          `[fediverse] reply from ${remote.handle ?? create.actorId.href} stored as a PENDING comment`
        )
      } else {
        strapi.log.debug(`[fediverse] reply ${note.id.href} ignored: ${result.reason}`)
      }
    })
    .on(Update, async (ctx, update) => {
      const strapi = ctx.data.strapi
      const note = await update.getObject({
        documentLoader: ctx.documentLoader,
        suppressError: true,
      })
      if (!(note instanceof Note) || note.id == null || update.actorId == null) return

      const result = await updateReply(
        strapi,
        {
          uri: note.id.href,
          actorId: update.actorId.href,
          contentHtml: String(note.content ?? ''),
        },
        await loadReplyContext(ctx)
      )
      if (result.status === 'applied') {
        strapi.log.info(`[fediverse] reply ${note.id.href} edited; sent back to PENDING`)
      }
    })
    .on(Delete, async (ctx, del) => {
      const strapi = ctx.data.strapi
      if (del.objectId == null || del.actorId == null) return

      const result = await removeReply(strapi, {
        uri: del.objectId.href,
        actorId: del.actorId.href,
      })
      if (result.status === 'applied') {
        strapi.log.info(`[fediverse] reply ${del.objectId.href} deleted remotely; marked removed`)
      }
    })
    .onError((ctx, error) => {
      ctx.data.strapi.log.error(`[fediverse] inbox listener failed: ${error.message}`)
    })

  return federation
}

/** A Federation with the backend it runs on and, once started, its queue worker. */
interface FederationHandle {
  federation: Federation<FediverseContextData>
  backend: FederationBackend
  worker?: { stop: AbortController; running: Promise<void> }
}

const federations = new WeakMap<Core.Strapi, FederationHandle>()

/** Instances whose federation was stopped: a late call must not open a pool nothing closes. */
const stopped = new WeakSet<Core.Strapi>()

function handleOf(strapi: Core.Strapi): FederationHandle {
  if (stopped.has(strapi)) throw new Error('[fediverse] federation is stopped')
  let handle = federations.get(strapi)
  if (handle == null) {
    const backend = createFederationBackend(strapi)
    handle = {
      backend,
      federation: createFediverseFederation({
        log: strapi.log,
        origin: federationOrigin(),
        backend,
        encryptionKey: () => configuredEncryptionKey(strapi),
        settle: (observation) => settleDelivery(strapi, observation),
        onUnreadable: (error) => {
          if (mayLog(lastUnreadableLog, 'unreadable', 1)) {
            strapi.log.error(
              `[fediverse] a queued delivery was dropped: it cannot be decrypted (${error instanceof Error ? error.name : 'unknown error'}); ENCRYPTION_KEY changed since it was queued. Repeats are held back for a minute.`
            )
          }
        },
        retryPolicy: () => {
          const policy: unknown = strapi.config.get('plugin::fediverse.outboxRetryPolicy')
          return typeof policy === 'function' ? (policy as RetryPolicy) : undefined
        },
      }),
    }
    federations.set(strapi, handle)
  }
  return handle
}

/** One Federation per Strapi instance, shared by the middleware and the article publisher. */
export function getFederation(strapi: Core.Strapi): Federation<FediverseContextData> {
  return handleOf(strapi).federation
}

/** Fedify's key-value store, also used for small counters of the plugin. */
export function getFederationKv(strapi: Core.Strapi): FederationBackend['kv'] {
  return handleOf(strapi).backend.kv
}

/** Where Fedify keeps its state and queue: `postgres`, or `memory` (lost on restart). */
export function getFederationBackendKind(strapi: Core.Strapi): FederationBackend['kind'] {
  return handleOf(strapi).backend.kind
}

/**
 * Starts the worker that delivers queued activities; called by the plugin's
 * `bootstrap()`. Messages left by a previous run, retries included, are
 * delivered from here on. Does nothing if it already runs.
 */
export function startFederationQueue(strapi: Core.Strapi): void {
  const handle = handleOf(strapi)
  if (handle.worker != null) return
  const stop = new AbortController()
  const running = (async () => {
    try {
      await handle.federation.startQueue({ strapi }, { signal: stop.signal })
    } catch (error) {
      strapi.log.error(
        `[fediverse] the delivery queue stopped, so nothing is delivered until the next restart: ${describeDeliveryError(error) ?? 'unknown error'}`
      )
    }
  })()
  handle.worker = { stop, running }
}

/**
 * Stops the queue worker and closes the connections Fedify opened; called by the
 * plugin's `destroy()`. A delivery in flight gets `QUEUE_STOP_TIMEOUT_MS` to finish.
 */
export async function stopFederation(strapi: Core.Strapi): Promise<void> {
  const handle = federations.get(strapi)
  if (handle == null) return
  federations.delete(strapi)
  stopped.add(strapi)
  if (handle.worker != null) {
    handle.worker.stop.abort()
    await Promise.race([
      handle.worker.running,
      pause(QUEUE_STOP_TIMEOUT_MS, undefined, { ref: false }),
    ])
  }
  await handle.backend.close()
}

/**
 * The path Fedify routes on: `@fedify/koa` builds its `Request` from `ctx.url`,
 * and the WHATWG parser resolves `.`, `..` and `%2e` segments. Classifying the
 * raw `ctx.path` would let `/fediverse/user/x/./inbox` reach the inbox as a read.
 */
function routedPath(ctx: KoaContext): string {
  try {
    return new URL(ctx.url, 'http://localhost').pathname
  } catch {
    return ctx.path
  }
}

function isFederationPath(path: string): boolean {
  return FEDERATION_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** Turns a Fedify URI template into an exact-match regex (one segment per variable). */
function pathTemplateToRegExp(template: string): RegExp {
  const pattern = template
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  // A trailing slash still counts as the inbox, so it cannot dodge the guard.
  return new RegExp(`^${pattern}/?$`)
}

const INBOX_PATTERNS = [INBOX_PATH, SHARED_INBOX_PATH].map(pathTemplateToRegExp)

function requestGuardKind(method: string, path: string): RequestGuardKind {
  return method === 'POST' && INBOX_PATTERNS.some((pattern) => pattern.test(path))
    ? 'inbox'
    : 'read'
}

/**
 * Koa middleware that hands federation paths to Fedify and passes every other
 * request on untouched.
 *
 * @remarks
 * Mounted in `register()`, ahead of `strapi::body`, so Fedify reads the raw
 * body that HTTP signature verification needs. A guard registered as
 * `plugin::fediverse.requestGuard` runs first and may answer the request
 * itself.
 */
export function mountFediverseMiddleware(
  strapi: Core.Strapi
): (ctx: KoaContext, next: () => Promise<void>) => Promise<void> {
  const fedify = createMiddleware<FediverseContextData, KoaContext>(getFederation(strapi), () => ({
    strapi,
  }))
  let lastGuardWarning = -Infinity
  const lastRefusalWarning = new Map<string, number>()

  /**
   * Runs the host app's guard (registered as `plugin::fediverse.requestGuard`,
   * e.g. a rate limiter). Read on every request: the root `register()` runs
   * after this plugin's, so the guard does not exist yet at mount time. A
   * missing guard, or one that fails, never blocks federation (fail open).
   */
  async function guardHandled(ctx: KoaContext): Promise<boolean> {
    const guard = strapi.config.get('plugin::fediverse.requestGuard') as RequestGuard | undefined
    if (typeof guard !== 'function') return false
    try {
      return (await guard(ctx, requestGuardKind(ctx.method, routedPath(ctx)))) === true
    } catch {
      const now = Date.now()
      if (now - lastGuardWarning >= WARNING_INTERVAL_MS) {
        lastGuardWarning = now
        strapi.log.warn('[fediverse] request guard failed; letting federation requests through')
      }
      return false
    }
  }

  // `@fedify/koa` turns the Node request stream of every non-GET request into a
  // web stream *before* it knows whether the route is its own. That stream
  // pauses the shared Node stream once its queue fills (bodies of roughly 16 KB
  // and up), and since this middleware runs ahead of `strapi::body` nobody
  // drains it: any large POST/PUT elsewhere in the app (e.g. publishing a long
  // article in the admin) then hangs until the client gives up. Requests that
  // are not federation paths must therefore never reach it.
  //
  // The guard and the digest check run before Fedify touches the request
  // stream, so a request they reject is answered with its body unread.
  return async (ctx: KoaContext, next: () => Promise<void>): Promise<void> => {
    if (!isFederationPath(routedPath(ctx))) return next()
    // Before the guard and Fedify, so a refusal or an error carries them too.
    for (const [name, value] of Object.entries(FEDERATION_SECURITY_HEADERS)) ctx.set(name, value)
    if (await guardHandled(ctx)) return
    const isInbox = requestGuardKind(ctx.method, routedPath(ctx)) === 'inbox'
    const refusal = isInbox ? inboxDigestRefusal(ctx.req.headers) : null
    if (refusal) {
      ctx.status = 401
      ctx.type = 'text/plain'
      ctx.body = refusal.message
      logInboxSignatureRefused(strapi.log, routedPath(ctx), refusal.reason)
      void recordInboxRefusal(() => getFederationKv(strapi), strapi.log)
      const now = Date.now()
      if (now - (lastRefusalWarning.get(refusal.reason) ?? -Infinity) >= WARNING_INTERVAL_MS) {
        lastRefusalWarning.set(refusal.reason, now)
        strapi.log.warn(refusal.warning)
      }
      return
    }
    try {
      await fedify(ctx, next)
    } catch (error) {
      // Koa would print every such 500 with its stack, and the cause is already
      // in the log; the body stays generic for unauthenticated callers.
      if (!isActorKeyFailure(error)) throw error
      ctx.status = 500
      ctx.type = 'text/plain'
      ctx.body = 'Internal Server Error'
      return
    }
    // An inbox answers 401 only when the authentication is refused (HTTP
    // signature, digest, signer and actor mismatch, integrity proofs); the
    // response is left as it is.
    if (ctx.status === 401 && isInbox) {
      logInboxSignatureRefused(strapi.log, routedPath(ctx), 'invalid-signature')
      void recordInboxRefusal(() => getFederationKv(strapi), strapi.log)
    }
  }
}
