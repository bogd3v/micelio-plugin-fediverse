/** The federation state kept for each article. */

/** What the last activity sent for an article ended as: its type, or `failed` when delivery threw. */
export type FederatedArticleStatus = 'created' | 'updated' | 'deleted' | 'failed'

/** The ActivityPub activity types sent for an article. */
export type FederatedActivityType = 'Create' | 'Update' | 'Delete'

/** A row of `plugin::fediverse.federated-article`. */
export interface FederatedArticleRow {
  id: number
  documentId: string
  articleDocumentId: string
  status: FederatedArticleStatus
  /** When the current `Create` was sent; `null` for a row migrated from the old store key. */
  createSentAt: string | null
  lastActivityAt: string | null
  lastActivityType: FederatedActivityType | null
  /** Delivery attempts of the last activity. */
  attempts: number
  /** The sanitized reason the last delivery failed, `null` when it did not. */
  lastError: string | null
}
