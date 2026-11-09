import type { Core } from '@strapi/strapi'

import { MAX_THREAD_DEPTH, THREAD_TIME_BUDGET_MS } from '../constants/replies'
import type {
  FetchedNote,
  IncomingReply,
  IngestResult,
  ReplyContext,
  ReplyParent,
  ThreadFetcher,
} from '../types/replies'
import { findPublishedArticle } from './articles'
import { isActorBlocked } from './followers'
import {
  findReplyParent,
  findStoredReply,
  ignored,
  ingestReply,
  NOT_OUR_CONVERSATION,
  storeReply,
  toCommentContent,
} from './replies'

/** The notes between a reply and our conversation, nearest first, and where the top one attaches. */
interface ResolvedThread {
  ancestors: FetchedNote[]
  parent: ReplyParent
}

/** Outcome of attaching one fetched note: the comment it is now, and whether it was just created. */
type AttachResult =
  | { status: 'applied'; documentId: string; created: boolean }
  | { status: 'ignored'; reason: string }

/**
 * Stores a remote reply, fetching the notes above it when its `inReplyTo`
 * matches nothing stored.
 *
 * @remarks
 * The one-hop case is `ingestReply` unchanged. Otherwise the parents are
 * fetched one by one, at most `MAX_THREAD_DEPTH` of them and within
 * `THREAD_TIME_BUDGET_MS`, until one answers an article, a stored comment or a
 * moderator's note. A chain that gets there is stored from the top down, every
 * note as a `PENDING` comment nested under the one above it; a chain that does
 * not is dropped whole. A note by a blocked actor stops the branch at that
 * note: the ones above it stay stored. See `docs/FEDIVERSE.md`, "Threads deeper
 * than one hop".
 *
 * @returns The outcome for the delivered reply.
 */
export async function ingestReplyThread(
  strapi: Core.Strapi,
  reply: IncomingReply,
  context: ReplyContext,
  fetcher: ThreadFetcher
): Promise<IngestResult> {
  const direct = await ingestReply(strapi, reply, context)
  if (direct.status === 'applied' || direct.reason !== NOT_OUR_CONVERSATION) return direct
  // Nothing above an empty reply is worth fetching: it would not be stored.
  if (!toCommentContent(reply.contentHtml, context.actorUsernames)) {
    return ignored('empty after sanitizing')
  }

  const signal = AbortSignal.timeout(THREAD_TIME_BUDGET_MS)
  const thread = await resolveThread(strapi, reply.inReplyTo, context, fetcher, signal)
  if ('reason' in thread) return ignored(thread.reason)
  if ((await findPublishedArticle(strapi, thread.parent.articleId)) == null) {
    return ignored('article is not published')
  }

  let parent = thread.parent
  let stored = 0
  for (const note of [...thread.ancestors].reverse()) {
    const step = await attach(strapi, note, parent, context, signal, fetcher)
    if (step.status === 'ignored') {
      logStoredAncestors(strapi, stored, reply.uri)
      return ignored(`a note above it was not stored: ${step.reason}`)
    }
    if (step.created) stored += 1
    parent = { articleId: parent.articleId, parentDocumentId: step.documentId }
  }
  logStoredAncestors(strapi, stored, reply.uri)

  // Checked again: the delivered note may have been stored while the thread was fetched.
  if (await findStoredReply(strapi, reply.uri)) return ignored('already stored')
  return storeReply(strapi, reply, parent, context)
}

/** Fetches the parents from `inReplyTo` up until one attaches to our conversation. */
async function resolveThread(
  strapi: Core.Strapi,
  inReplyTo: string,
  context: ReplyContext,
  fetcher: ThreadFetcher,
  signal: AbortSignal
): Promise<ResolvedThread | { reason: string }> {
  const ancestors: FetchedNote[] = []
  let uri = inReplyTo
  while (ancestors.length < MAX_THREAD_DEPTH) {
    if (signal.aborted) return { reason: 'time budget spent before the thread reached us' }
    const note = await fetcher.fetchNote(uri, signal)
    if (note == null) return { reason: `parent ${uri} could not be fetched or failed its checks` }
    ancestors.push(note)
    if (note.inReplyTo == null) return { reason: NOT_OUR_CONVERSATION }

    const parent = await findReplyParent(strapi, note.inReplyTo, context)
    if (parent) return { ancestors, parent }
    uri = note.inReplyTo
  }
  return { reason: `no part of our conversation within ${MAX_THREAD_DEPTH} notes` }
}

/**
 * Stores one fetched note under `parent`, unless its author is blocked. A note
 * stored meanwhile (another delivery of the same thread) is reused.
 */
async function attach(
  strapi: Core.Strapi,
  note: FetchedNote,
  parent: ReplyParent,
  context: ReplyContext,
  signal: AbortSignal,
  fetcher: ThreadFetcher
): Promise<AttachResult> {
  if (await isActorBlocked(strapi, note.actorId))
    return { status: 'ignored', reason: 'actor is blocked' }
  const existing = await findStoredReply(strapi, note.uri)
  if (existing) return { status: 'applied', documentId: existing, created: false }

  const author = await fetcher.describeAuthor(note.actorId, signal)
  const result = await storeReply(
    strapi,
    { ...note, inReplyTo: note.inReplyTo ?? '', ...author },
    parent,
    context
  )
  return result.status === 'applied' ? { ...result, created: true } : result
}

function logStoredAncestors(strapi: Core.Strapi, count: number, replyUri: string): void {
  if (count === 0) return
  strapi.log.info(
    `[fediverse] fetched ${count} note(s) above reply ${replyUri} and stored them as PENDING comments`
  )
}
