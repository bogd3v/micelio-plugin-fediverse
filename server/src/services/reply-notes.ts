import type { Core } from '@strapi/strapi'

import {
  PUBLIC_COLLECTION,
  Create,
  Delete,
  Mention,
  Note,
  Tombstone,
  Update,
} from '@fedify/fedify/vocab'
import type { Context } from '@fedify/fedify'

import { COMMENT_UID } from '../constants/uids'
import type { ReplyComment, ReplyTarget } from '../types/reply-notes'
import { escapeHtml } from '../utils/html'
import { findPublishedArticle, getFrontendArticleUrl, toInstant } from './articles'
import { isActorBlocked } from './followers'

const RELATED_PREFIX = 'api::article.article:'

/** The comment with the two facts of its parent a federated reply needs. */
export async function loadReplyComment(
  strapi: Core.Strapi,
  where: { id: number } | { documentId: string }
): Promise<ReplyComment | null> {
  const row = (await strapi.db.query(COMMENT_UID).findOne({
    where,
    populate: {
      threadOf: {
        select: [
          'fediverseUri',
          'fediverseActorHandle',
          'authorId',
          'removed',
          'blocked',
          'blockedThread',
          'approvalStatus',
        ],
      },
    },
  })) as ReplyComment | null
  return row
}

/**
 * Whether the reply is shown: not removed, not blocked (itself or by a blocked thread above it),
 * not waiting for or refused by a moderator. An admin's reply made through the plugin has no approval status at all, and is shown.
 */
export function isNoteVisible(comment: ReplyComment): boolean {
  return (
    comment.removed !== true &&
    comment.blocked !== true &&
    comment.blockedThread !== true &&
    comment.approvalStatus !== 'PENDING' &&
    comment.approvalStatus !== 'REJECTED'
  )
}

/** The comments plugin's permission to moderate: write, edit and remove comments in the admin. */
const MODERATE_PERMISSION = 'plugin::comments.comments-moderate'

/**
 * Whether the admin user who wrote a reply may moderate comments.
 *
 * @remarks
 * The comments plugin's admin routes check no permission on the server: any admin account can
 * post a comment, and `isAdminComment` only says an admin wrote it. Federating signs the text as
 * the blog, so it asks for the permission itself, built the way Strapi's admin login builds an
 * admin's ability. A comment whose author is not a known admin user does not federate.
 */
async function authorMayModerate(strapi: Core.Strapi, authorId: string | null): Promise<boolean> {
  const id = Number(authorId)
  if (!Number.isInteger(id) || id <= 0) return false
  const user = await strapi.service('admin::user').findOne(id)
  if (user == null || user.isActive === false) return false
  const ability = await strapi.service('admin::permission').engine.generateUserAbility(user)
  return ability.can(MODERATE_PERMISSION) === true
}

/** Whether the comment a reply answers is itself shown: not removed, blocked, pending or rejected. */
function isParentShown(parent: NonNullable<ReplyComment['threadOf']>): boolean {
  return (
    parent.removed !== true &&
    parent.blocked !== true &&
    parent.blockedThread !== true &&
    parent.approvalStatus !== 'PENDING' &&
    parent.approvalStatus !== 'REJECTED'
  )
}

/**
 * Where a moderator's reply goes, or `null` when it does not federate.
 *
 * @remarks
 * Only a comment written by an admin user who may moderate comments (`isAdminComment`, and the
 * permission above) that answers a **fediverse** comment of someone else federates: its parent has
 * a `fediverseUri` (a remote note id; a moderator's own reply has none, only a `fediverseNoteUri`),
 * is itself shown, and its `authorId` is the remote actor's id; and the article is published.
 * Readers' and guests' comments never do, nor does a reply to a local comment.
 */
export async function resolveReplyTarget(
  strapi: Core.Strapi,
  comment: ReplyComment
): Promise<ReplyTarget | null> {
  if (comment.isAdminComment !== true) return null
  const parent = comment.threadOf
  if (parent?.fediverseUri == null || parent.authorId == null || !isParentShown(parent)) return null
  try {
    new URL(parent.fediverseUri)
    new URL(parent.authorId)
  } catch {
    return null
  }

  const documentId = comment.related.startsWith(RELATED_PREFIX)
    ? comment.related.slice(RELATED_PREFIX.length)
    : null
  const article = documentId ? await findPublishedArticle(strapi, documentId) : null
  if (article == null) return null
  if (!(await authorMayModerate(strapi, comment.authorId))) return null

  return {
    parentUri: parent.fediverseUri,
    remoteAuthorId: parent.authorId,
    remoteAuthorHandle: parent.fediverseActorHandle,
    articleUrl: getFrontendArticleUrl(article.slug, article.locale),
    deliverToAuthor: !(await isActorBlocked(strapi, parent.authorId)),
  }
}

/**
 * The four entities the comments plugin's sanitizer writes for `&`, `<`, `>` and `"`, undone, so
 * the text is escaped once, by `commentToHtml`, and not shown remotely as `&amp;amp;`. `&amp;`
 * goes last, so an encoded entity stays one level encoded.
 */
function decodeSanitizedText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/**
 * The comment text as escaped HTML: a paragraph per blank line, a `<br>` per line break.
 *
 * @remarks
 * The text is a moderator's plain text, shown as text on the site; here too, any markup in it is
 * escaped and not sent as markup.
 */
export function commentToHtml(text: string): string {
  return decodeSanitizedText(text)
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * The `Note` of a moderator's reply: addressed to the remote author, with the public collection
 * and the followers in `cc`, and linking to the comment on the article page.
 */
export function buildNote(
  ctx: Context<unknown>,
  actorIdentifier: string,
  comment: ReplyComment,
  target: ReplyTarget
): Note {
  const anchor = new URL(target.articleUrl.href)
  anchor.hash = `comment-${comment.documentId}`
  return new Note({
    id: ctx.getObjectUri(Note, { documentId: comment.documentId }),
    attribution: ctx.getActorUri(actorIdentifier),
    replyTarget: new URL(target.parentUri),
    content: commentToHtml(comment.content),
    url: anchor,
    published: toInstant(comment.createdAt),
    updated: comment.updatedAt ? toInstant(comment.updatedAt) : undefined,
    to: new URL(target.remoteAuthorId),
    ccs: [PUBLIC_COLLECTION, ctx.getFollowersUri(actorIdentifier)],
    // Remote servers notify a person only of a mention.
    tags: [
      new Mention({
        href: new URL(target.remoteAuthorId),
        name: target.remoteAuthorHandle ?? target.remoteAuthorId,
      }),
    ],
  })
}

/** The addressing every activity of a reply carries. */
function addressing(ctx: Context<unknown>, actorIdentifier: string, target: ReplyTarget) {
  return {
    actor: ctx.getActorUri(actorIdentifier),
    to: new URL(target.remoteAuthorId),
    ccs: [PUBLIC_COLLECTION, ctx.getFollowersUri(actorIdentifier)],
  }
}

/**
 * An id of its own for every activity: a server that remembers the ids it has handled (or a
 * deleted URL) ignores a repeated one, so a second `Delete` or `Create` of the same note needs a
 * new id.
 */
function activityId(ctx: Context<unknown>, documentId: string, fragment: string): URL {
  const id = new URL(ctx.getObjectUri(Note, { documentId }).href)
  id.hash = fragment
  return id
}

/** `Create`, `Update` or `Delete` (with a `Tombstone`) of a reply, addressed like the note. */
export function buildReplyActivity(
  kind: 'create' | 'update' | 'delete',
  ctx: Context<unknown>,
  actorIdentifier: string,
  comment: ReplyComment,
  target: ReplyTarget
): Create | Update | Delete {
  const base = addressing(ctx, actorIdentifier, target)
  if (kind === 'delete') {
    return new Delete({
      ...base,
      id: activityId(ctx, comment.documentId, `delete-${Date.now()}`),
      object: new Tombstone({ id: ctx.getObjectUri(Note, { documentId: comment.documentId }) }),
    })
  }
  const options = {
    ...base,
    id: activityId(ctx, comment.documentId, `${kind}-${Date.now()}`),
    object: buildNote(ctx, actorIdentifier, comment, target),
    published: toInstant(kind === 'create' ? comment.createdAt : new Date().toISOString()),
  }
  return kind === 'create' ? new Create(options) : new Update(options)
}

/**
 * The reply a note URL stands for, when it is one that is served: an admin's reply to a fediverse
 * comment that is shown. Anything else, including a reply that was removed, is `null` (a `404`).
 */
export async function findServedReply(
  strapi: Core.Strapi,
  documentId: string
): Promise<{ comment: ReplyComment; target: ReplyTarget } | null> {
  const comment = await loadReplyComment(strapi, { documentId })
  if (comment == null || comment.fediverseNoteUri == null || !isNoteVisible(comment)) return null
  const target = await resolveReplyTarget(strapi, comment)
  return target ? { comment, target } : null
}
