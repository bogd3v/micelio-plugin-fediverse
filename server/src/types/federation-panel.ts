/** What the admin panel of an article shows and sends. */

import type { FederatedActivityType, FederatedArticleStatus } from './federated-articles'

/** Why an article cannot be federated now; stable, a client branches on it. */
export type FederateBlocker = 'locale-not-federated' | 'article-not-published'

/** The error codes of the admin routes; stable, a client branches on them. */
export type FederationProblemCode =
  | FederateBlocker
  | 'article-not-found'
  | 'forbidden'
  | 'queue-unavailable'
  | 'follower-not-found'
  | 'not-failed'

/** Fediverse interactions with one article; blocked actors do not count. */
export interface FederationCounts {
  likes: number
  boosts: number
  /** Approved replies that are not removed. */
  repliesApproved: number
  /** Replies waiting for a moderator. */
  repliesPending: number
}

/**
 * The federation state of one article, as `GET /fediverse-panel/articles/:documentId/federation` answers.
 *
 * @remarks
 * `state` is `never` when no activity was ever queued for the article, else the status of the
 * row of its last activity. Fedify reports no successful delivery, so no state means "delivered".
 */
export interface ArticleFederation {
  documentId: string
  state: 'never' | FederatedArticleStatus
  lastActivityType: FederatedActivityType | null
  /** When the last activity was queued. */
  lastActivityAt: string | null
  createSentAt: string | null
  attempts: number
  /** The sanitized reason of the last failed delivery, `null` when none failed. */
  lastError: string | null
  counts: FederationCounts
  /** Whether "Federate now" would queue an activity, and if not why. */
  canFederate: { allowed: true } | { allowed: false; code: FederateBlocker }
}

/** What `POST /fediverse-panel/articles/:documentId/federate` answers (202). */
export interface FederateResult {
  /** `Create` for an article never federated, `Update` otherwise. */
  activity: 'Create' | 'Update'
  /** Followers the activity was queued for. */
  queued: number
  /** Followers left out because their inbox is gone. */
  skipped: number
}
