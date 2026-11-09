import type { Core } from '@strapi/strapi'

import { INTERACTION_UID } from '../constants/uids'
import type { InteractionInput, InteractionType } from '../types/interactions'
import { listFollowers } from './followers'

// The article is referenced by documentId rather than a relation: articles are
// draft-and-publish + localized, so a relation would point at one specific
// row and could be orphaned every time the article is re-published.
function query(strapi: Core.Strapi) {
  return strapi.db.query(INTERACTION_UID)
}

/**
 * Strapi has no composite unique constraint, and its `unique: true` is only a
 * Document Service validation — it creates no database index, so `db.query`
 * (used here) can insert duplicates. (type, actor, article) is folded into one
 * key that the deduplication below is built on.
 */
export function interactionKey(type: InteractionType, actorId: string, documentId: string): string {
  return `${type}|${actorId}|${documentId}`
}

/**
 * Idempotent: a repeated Like/Announce from the same actor is `exists`, never
 * a second row. With no unique index to lean on, concurrent deliveries of the
 * same activity are settled after the insert: only the oldest row for the key
 * survives, so exactly one remains even across several Strapi processes.
 */
export async function recordInteraction(
  strapi: Core.Strapi,
  input: InteractionInput
): Promise<'created' | 'exists'> {
  const key = interactionKey(input.type, input.actorId, input.articleDocumentId)
  if (await query(strapi).findOne({ where: { interactionKey: key } })) return 'exists'

  const created = (await query(strapi).create({
    data: {
      type: input.type,
      actorId: input.actorId,
      handle: input.handle ?? null,
      articleDocumentId: input.articleDocumentId,
      interactionKey: key,
    },
  })) as { id: number; documentId: string }

  // Keep the oldest row and drop every other one, not just our own: on
  // Postgres a lower id can commit after a higher one, so each writer must
  // also clean up rows it didn't insert for the set to converge to one.
  const rows = (await query(strapi).findMany({
    where: { interactionKey: key },
    orderBy: { id: 'asc' },
  })) as Array<{ id: number; documentId: string }>
  const [oldest, ...duplicates] = rows
  for (const duplicate of duplicates) {
    await query(strapi).delete({ where: { documentId: duplicate.documentId } })
  }
  return oldest.id === created.id ? 'created' : 'exists'
}

/**
 * Removes an actor's like or boost of an article, on `Undo(Like)` or
 * `Undo(Announce)`.
 *
 * @returns `false` when there was nothing to remove.
 */
export async function removeInteraction(
  strapi: Core.Strapi,
  input: Omit<InteractionInput, 'handle'>
): Promise<boolean> {
  const key = interactionKey(input.type, input.actorId, input.articleDocumentId)
  const existing = (await query(strapi).findOne({ where: { interactionKey: key } })) as {
    documentId: string
  } | null
  if (!existing) return false

  await query(strapi).delete({ where: { documentId: existing.documentId } })
  return true
}

/**
 * Aggregate counts only. Interactions from actors an admin has blocked don't
 * count, including ones recorded before the block.
 */
export async function countInteractions(
  strapi: Core.Strapi,
  articleDocumentId: string
): Promise<{ likes: number; boosts: number }> {
  const blocked = (await listFollowers(strapi, { blocked: true })).map((f) => f.actorId)
  const count = (type: InteractionType) =>
    query(strapi).count({
      where: {
        type,
        articleDocumentId,
        ...(blocked.length ? { actorId: { $notIn: blocked } } : {}),
      },
    })

  const [likes, boosts] = await Promise.all([count('like'), count('boost')])
  return { likes, boosts }
}

export default (): {
  recordInteraction: typeof recordInteraction
  removeInteraction: typeof removeInteraction
  countInteractions: typeof countInteractions
} => ({
  recordInteraction,
  removeInteraction,
  countInteractions,
})
