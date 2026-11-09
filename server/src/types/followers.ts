/** Remote actors following the blog. */

/** A remote actor that follows the blog, or that an admin has blocked. */
export interface FollowerRecord {
  documentId: string
  /** The actor's ActivityPub id. */
  actorId: string
  /** `@user@domain`, or null when it could not be resolved. */
  handle: string | null
  name: string | null
  /** Where activities are delivered to this follower, or null when unknown. */
  inbox: string | null
  avatar: string | null
  /**
   * Set by an admin: the actor receives no deliveries, its new likes, boosts
   * and replies are ignored, and its interactions stop counting.
   */
  blocked: boolean
  /**
   * When the follower's inbox answered a permanent failure (`404` or `410`), or
   * `null`. Fan-outs skip the follower until it sends an activity again; the
   * followers collection and its count still include it.
   */
  unreachableSince: string | null
}

/**
 * What a `Follow` stores about the remote actor, taken from its actor document
 * when it can be fetched.
 */
export interface FollowerInput {
  actorId: string
  handle?: string | null
  name?: string | null
  inbox?: string | null
  avatar?: string | null
}
