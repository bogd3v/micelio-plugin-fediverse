import type { Core } from '@strapi/strapi'

import type { Actor } from '@fedify/fedify/vocab'
import { Note } from '@fedify/fedify/vocab'

import { ACTOR_IDENTIFIER } from '../constants/actor'
import { COMMENT_UID } from '../constants/uids'
import type { ReplyComment, ReplyTarget } from '../types/reply-notes'
import {
  buildReplyActivity,
  isNoteVisible,
  loadReplyComment,
  resolveReplyTarget,
} from './reply-notes'
import { createContext, describeFanOut, sendToFollowers, type ExtraRecipient } from './publisher'

/** Fields of a comment whose change can show or hide a reply. */
const VISIBILITY_FIELDS = ['removed', 'blocked', 'blockedThread', 'approvalStatus']
/** The fields this module writes itself: an update of only these changes nothing remote servers see. */
const OWN_FIELDS = ['fediverseNoteUri', 'fediverseNoteRetracted']
/** Most replies re-examined after a write that names no comment (`updateMany`). */
const SWEEP_LIMIT = 500

interface LifecycleEvent {
  params?: { data?: Record<string, unknown>; where?: Record<string, unknown> }
  result?: { id?: number }
}

let unsubscribe: (() => void) | undefined
/** The work in progress of each comment, so two writes to one reply are handled one after the other. */
const chains = new Map<number, Promise<void>>()

/** Runs `work` after the work already in progress for the same comment. */
async function inTurn(id: number, work: () => Promise<void>): Promise<void> {
  const previous = chains.get(id) ?? Promise.resolve()
  const mine = (async () => {
    await previous
    await work()
  })()
  chains.set(id, mine)
  try {
    await mine
  } finally {
    if (chains.get(id) === mine) chains.delete(id)
  }
}

/** Resolves the remote author's actor with the blog's signed loader, for servers that require it. */
async function authorRecipient(
  ctx: ReturnType<typeof createContext>,
  target: ReplyTarget
): Promise<ExtraRecipient | null> {
  if (!target.deliverToAuthor) return null
  const documentLoader = await ctx.getDocumentLoader({ identifier: ACTOR_IDENTIFIER })
  const actor = (await ctx.lookupObject(target.remoteAuthorId, { documentLoader })) as Actor | null
  if (actor?.id == null || actor.inboxId == null) return null
  return { id: actor.id, inboxId: actor.inboxId, endpoints: actor.endpoints }
}

/**
 * Brings what remote servers have in line with what the reply is now.
 *
 * @remarks
 * The state is explicit: a note is _live_ remotely when it has a `fediverseNoteUri` and was not
 * retracted. A shown reply that is not live is sent as a `Create` (the first time, or again after a
 * `Delete`); a hidden one that is live is retracted with a `Delete`; a shown, live one whose text
 * changed is an `Update`. Because it compares states, not changes, a write that changes nothing
 * visible sends nothing, and two writes in a row send nothing twice. The note id is stored before a
 * `Create` is queued (a server may fetch it at once) and taken back if queueing fails, so a reply
 * that never went out is not taken for one that did. Activity ids are unique, so a repeated
 * `Delete` or `Create` is not dropped as one already seen; a server that remembers a deleted URL
 * (Mastodon) still ignores a `Create` after a `Delete`, so a retracted reply stays retracted there.
 */
async function syncReply(strapi: Core.Strapi, id: number, textChanged: boolean): Promise<void> {
  const comment = await loadReplyComment(strapi, { id })
  if (comment == null) return
  const target = await resolveReplyTarget(strapi, comment)
  if (target == null) return
  await sendForState(strapi, comment, target, textChanged)
}

async function sendForState(
  strapi: Core.Strapi,
  comment: ReplyComment,
  target: ReplyTarget,
  textChanged: boolean
): Promise<void> {
  const ctx = createContext(strapi)
  const visible = isNoteVisible(comment)
  const live = comment.fediverseNoteUri != null && comment.fediverseNoteRetracted !== true

  let kind: 'create' | 'update' | 'delete' | null = null
  if (visible && !live) kind = 'create'
  else if (!visible && live) kind = 'delete'
  else if (visible && live && textChanged) kind = 'update'
  if (kind == null) return

  const comments = strapi.db.query(COMMENT_UID)
  const noteUri = ctx.getObjectUri(Note, { documentId: comment.documentId }).href
  const before = {
    fediverseNoteUri: comment.fediverseNoteUri,
    fediverseNoteRetracted: comment.fediverseNoteRetracted,
  }
  if (kind === 'create') {
    await comments.update({
      where: { id: comment.id },
      data: { fediverseNoteUri: noteUri, fediverseNoteRetracted: false },
    })
  }

  try {
    const recipient = await authorRecipient(ctx, target)
    if (recipient == null && target.deliverToAuthor) {
      strapi.log.warn(
        `[fediverse] the remote author of reply ${comment.documentId} could not be resolved; it goes to the followers only`
      )
    }
    const fanOut = await sendToFollowers(
      strapi,
      buildReplyActivity(
        kind,
        ctx,
        ACTOR_IDENTIFIER,
        { ...comment, fediverseNoteUri: noteUri },
        target
      ),
      recipient ? [recipient] : []
    )
    if (kind === 'delete') {
      await comments.update({ where: { id: comment.id }, data: { fediverseNoteRetracted: true } })
    }
    strapi.log.info(
      `[fediverse] ${kind === 'create' ? 'Create' : kind === 'update' ? 'Update' : 'Delete'}(Note) for reply ${comment.documentId}: ${describeFanOut(fanOut)}${recipient ? ', and the remote author' : ''}`
    )
  } catch (error) {
    if (kind === 'create') {
      await comments.update({ where: { id: comment.id }, data: before })
    }
    throw error
  }
}

/** Runs the work of a lifecycle hook without holding the request: federating is a side effect. */
function inBackground(strapi: Core.Strapi, work: () => Promise<void>): void {
  void (async () => {
    try {
      await work()
    } catch (error) {
      strapi.log.error(
        `[fediverse] federating a reply failed: ${error instanceof Error ? error.name : 'unknown error'}`
      )
    }
  })()
}

/** Examines again every reply that was federated: a write that names no comment may have hidden some. */
async function sweep(strapi: Core.Strapi): Promise<void> {
  const rows = (await strapi.db.query(COMMENT_UID).findMany({
    where: { fediverseNoteUri: { $notNull: true } },
    select: ['id'],
    limit: SWEEP_LIMIT,
  })) as Array<{ id: number }>
  for (const row of rows) await inTurn(row.id, () => syncReply(strapi, row.id, false))
}

/**
 * Retracts the federated replies a write is about to delete, while they can still be read: after
 * the delete there is no comment left to address a `Delete` from.
 */
async function retractBeforeDelete(
  strapi: Core.Strapi,
  where: Record<string, unknown> | undefined
): Promise<void> {
  if (where == null) return
  const rows = (await strapi.db.query(COMMENT_UID).findMany({
    where: { $and: [where, { fediverseNoteUri: { $notNull: true } }] },
    select: ['id'],
    limit: SWEEP_LIMIT,
  })) as Array<{ id: number }>
  for (const { id } of rows) {
    const comment = await loadReplyComment(strapi, { id })
    if (comment == null || comment.fediverseNoteRetracted === true) continue
    const target = await resolveReplyTarget(strapi, comment)
    if (target == null) continue
    inBackground(strapi, () =>
      inTurn(id, () => sendForState(strapi, { ...comment, removed: true }, target, false))
    )
  }
}

/**
 * Federates the replies a moderator writes to fediverse comments. Hooks the comments plugin's
 * database lifecycle, so it sees every way a comment is created, changed or removed, the admin's
 * moderation views included. Called by the plugin's `bootstrap()`.
 */
export function subscribeReplies(strapi: Core.Strapi): void {
  unsubscribe = strapi.db.lifecycles.subscribe({
    models: [COMMENT_UID],
    afterCreate(event: LifecycleEvent) {
      const id = event.result?.id
      if (typeof id === 'number') {
        inBackground(strapi, () => inTurn(id, () => syncReply(strapi, id, false)))
      }
    },
    afterUpdate(event: LifecycleEvent) {
      const id = event.result?.id
      const changed = Object.keys(event.params?.data ?? {})
      if (typeof id !== 'number' || changed.every((field) => OWN_FIELDS.includes(field))) return
      inBackground(strapi, () =>
        inTurn(id, () => syncReply(strapi, id, changed.includes('content')))
      )
    },
    afterUpdateMany(event: LifecycleEvent) {
      const changed = Object.keys(event.params?.data ?? {})
      if (changed.some((field) => VISIBILITY_FIELDS.includes(field))) {
        inBackground(strapi, () => sweep(strapi))
      }
    },
    async beforeDelete(event: LifecycleEvent) {
      await retractBeforeDelete(strapi, event.params?.where)
    },
    async beforeDeleteMany(event: LifecycleEvent) {
      await retractBeforeDelete(strapi, event.params?.where)
    },
  })
}

/** Stops federating replies; called by the plugin's `destroy()`. */
export function unsubscribeReplies(): void {
  unsubscribe?.()
  unsubscribe = undefined
}
