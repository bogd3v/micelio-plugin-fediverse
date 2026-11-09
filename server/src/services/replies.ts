import type { Core } from '@strapi/strapi'

import { ARTICLE_UID, COMMENT_UID } from '../constants/uids'
import type { IncomingReply, IngestResult, ReplyContext, ReplyParent } from '../types/replies'
import { findPublishedArticle, getDefaultLocale, resolveArticleId } from './articles'
import { isActorBlocked } from './followers'

const MAX_CONTENT_LENGTH = 5000

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

/** An HTML comment. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g

/**
 * Something that reads as an HTML tag: a name followed by whitespace, `/` or
 * `>`, or a `<!` declaration. A `<` followed by anything else (`1 < 2`,
 * `Map<K, V>`) is text.
 */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^>]*)?>|<![^>]*>/g

/** A tag start with no `>` left to close it, removed when stripping keeps rebuilding tags. */
const TAG_START = /<(?=[A-Za-z/!])/g

/** A comment opener with no `-->` after it, which no other pattern removes. */
const COMMENT_OPEN = /<!--/g

/** Passes of tag stripping before the tag starts that remain are dropped. */
const MAX_STRIP_PASSES = 4

/** One pass: complete comments, tags, then a comment opener that was never closed. */
function removeMarkup(text: string): string {
  return text.replace(HTML_COMMENT, '').replace(HTML_TAG, '').replace(COMMENT_OPEN, '')
}

/**
 * Removes the tags and comments of an HTML text and keeps every other `<`.
 * Stripping can bring the pieces of a tag together (`<scr<b>ipt>`), so it
 * repeats until nothing is left to strip. A few passes bound the work on
 * hostile nesting; what then remains of a tag start is dropped.
 */
function stripTags(text: string): string {
  let current = text
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = removeMarkup(current)
    if (next === current) return next
    current = next
  }
  return removeMarkup(current.replace(TAG_START, ''))
}

/**
 * Remote Note content is HTML from an untrusted server. Comments are stored as
 * plain text, so strip every tag (keeping paragraph and line breaks) and decode
 * entities *after* stripping — an encoded `&lt;script&gt;` must end up as
 * harmless literal text, never as markup. A `<` that does not start a tag
 * (`1 < 2`) stays.
 */
export function htmlToPlainText(html: string): string {
  const text = stripTags(
    html
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/\s*(?:p|div|li|blockquote|h[1-6])\s*>/gi, '\n\n')
  )

  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Mastodon prefixes replies with a mention of the account being replied to;
 * drop ours, under any of the usernames the blog answers to.
 */
export function stripLeadingMentions(text: string, usernames: string | string[]): string {
  const names = (Array.isArray(usernames) ? usernames : [usernames])
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return text.replace(new RegExp(`^(?:@(?:${names})(?:@[\\w.-]+)?\\s+)+`, 'i'), '').trim()
}

/**
 * The text a reply is stored with: the Note's HTML as plain text, without the
 * leading mentions of the blog, cut to 5000 characters. An empty result means
 * there is nothing to store and the reply is ignored.
 */
export function toCommentContent(html: string, usernames: string | string[]): string {
  return stripLeadingMentions(htmlToPlainText(html), usernames).slice(0, MAX_CONTENT_LENGTH)
}

interface CommentRow {
  documentId: string
  related?: string | null
  authorId?: string | null
  content?: string | null
}

/** An `ignored` result with its reason. */
export const ignored = (reason: string): IngestResult => ({ status: 'ignored', reason })

// The generated types for plugin content types don't include the comments
// plugin's attributes (or our extension's), so type the document service by hand.
interface CommentDocuments {
  findFirst(params: { filters: Record<string, unknown> }): Promise<unknown>
  create(params: { data: Record<string, unknown> }): Promise<unknown>
  update(params: { documentId: string; data: Record<string, unknown> }): Promise<unknown>
}

function comments(strapi: Core.Strapi): CommentDocuments {
  return strapi.documents(COMMENT_UID) as unknown as CommentDocuments
}

async function findCommentByUri(strapi: Core.Strapi, uri: string): Promise<CommentRow | null> {
  return (await comments(strapi).findFirst({
    filters: { fediverseUri: uri },
  })) as CommentRow | null
}

async function findCommentByNoteUri(strapi: Core.Strapi, uri: string): Promise<CommentRow | null> {
  return (await comments(strapi).findFirst({
    filters: { fediverseNoteUri: uri },
  })) as CommentRow | null
}

/** Why a reply whose `inReplyTo` matches nothing stored is ignored by `ingestReply`. */
export const NOT_OUR_CONVERSATION = 'not a reply to one of our articles'

/** The documentId of the comment stored for a remote note, or `null`. */
export async function findStoredReply(strapi: Core.Strapi, uri: string): Promise<string | null> {
  return (await findCommentByUri(strapi, uri))?.documentId ?? null
}

/**
 * Finds the article a reply belongs to, and the parent comment when it is a
 * reply to a stored fediverse reply or to a moderator's own note. `null` when
 * `inReplyTo` is none of these.
 */
export async function findReplyParent(
  strapi: Core.Strapi,
  inReplyTo: string,
  context: ReplyContext
): Promise<ReplyParent | null> {
  const articleId = await resolveArticleId(strapi, inReplyTo, context.parseArticleUri)
  if (articleId) return { articleId, parentDocumentId: null }

  // A reply to a remote comment, or to a moderator's own reply (whose note id is not public).
  const parent =
    (await findCommentByUri(strapi, inReplyTo)) ?? (await findCommentByNoteUri(strapi, inReplyTo))
  const related = parent?.related ?? ''
  const separator = related.lastIndexOf(':')
  if (parent && related.slice(0, separator) === ARTICLE_UID) {
    return { articleId: related.slice(separator + 1), parentDocumentId: parent.documentId }
  }

  return null
}

/**
 * Writes a remote reply as a `PENDING` comment under `parent`, with its content
 * sanitized. The caller has checked the author, the dedupe and the article.
 * Only the default locale is federated, so the reply belongs to that version
 * of the article and is stored in its locale, where the frontend asks for it.
 */
export async function storeReply(
  strapi: Core.Strapi,
  reply: IncomingReply,
  parent: ReplyParent,
  context: ReplyContext
): Promise<IngestResult> {
  const content = toCommentContent(reply.contentHtml, context.actorUsernames)
  if (!content) return ignored('empty after sanitizing')

  const created = (await comments(strapi).create({
    data: {
      content,
      related: `${ARTICLE_UID}:${parent.articleId}`,
      locale: await getDefaultLocale(strapi),
      approvalStatus: 'PENDING',
      isAdminComment: false,
      authorId: reply.actorId,
      authorName: reply.name ?? reply.handle ?? reply.actorId,
      authorAvatar: reply.avatar ?? undefined,
      fediverseUri: reply.uri,
      fediverseActorHandle: reply.handle ?? undefined,
      ...(parent.parentDocumentId ? { threadOf: parent.parentDocumentId } : {}),
    },
  })) as CommentRow

  return { status: 'applied', documentId: created.documentId }
}

/**
 * Stores a remote reply as a comment on the article it answers, or under the
 * stored comment it answers (one hop). It always enters as `PENDING`: the
 * content is untrusted and a moderator approves it. Deeper threads are
 * resolved by `ingestReplyThread`.
 */
export async function ingestReply(
  strapi: Core.Strapi,
  reply: IncomingReply,
  context: ReplyContext
): Promise<IngestResult> {
  if (await isActorBlocked(strapi, reply.actorId)) return ignored('actor is blocked')
  if (await findCommentByUri(strapi, reply.uri)) return ignored('already stored')

  const parent = await findReplyParent(strapi, reply.inReplyTo, context)
  if (!parent) return ignored(NOT_OUR_CONVERSATION)
  if ((await findPublishedArticle(strapi, parent.articleId)) == null) {
    return ignored('article is not published')
  }

  return storeReply(strapi, reply, parent, context)
}

/**
 * Applies a remote edit. Edited text goes back to `PENDING`, otherwise an
 * author could get something harmless approved and then swap in spam.
 */
export async function updateReply(
  strapi: Core.Strapi,
  update: { uri: string; actorId: string; contentHtml: string },
  context: ReplyContext
): Promise<IngestResult> {
  const comment = await findCommentByUri(strapi, update.uri)
  if (!comment) return ignored('unknown reply')
  if (comment.authorId !== update.actorId) return ignored('not the reply author')

  const content = toCommentContent(update.contentHtml, context.actorUsernames)
  if (!content) return ignored('empty after sanitizing')
  if (content === comment.content) return ignored('content unchanged')

  await comments(strapi).update({
    documentId: comment.documentId,
    data: { content, approvalStatus: 'PENDING' },
  })
  return { status: 'applied', documentId: comment.documentId }
}

/** Marks the comment for a deleted remote Note as removed (kept for the thread structure). */
export async function removeReply(
  strapi: Core.Strapi,
  removal: { uri: string; actorId: string }
): Promise<IngestResult> {
  const comment = await findCommentByUri(strapi, removal.uri)
  if (!comment) return ignored('unknown reply')
  if (comment.authorId !== removal.actorId) return ignored('not the reply author')

  await comments(strapi).update({ documentId: comment.documentId, data: { removed: true } })
  return { status: 'applied', documentId: comment.documentId }
}
