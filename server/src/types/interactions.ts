/** Likes and boosts received on articles. */

/** `like` for an ActivityPub `Like`, `boost` for an `Announce`. */
export type InteractionType = 'like' | 'boost'

/** A like or boost of an article by a remote actor. */
export interface InteractionInput {
  type: InteractionType
  actorId: string
  handle?: string | null
  articleDocumentId: string
}
