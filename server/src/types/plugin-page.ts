/** What the plugin page of the admin shows and sends. */

/** The diagnostics, in the order the page shows them. */
export type DiagnosticId =
  'public-url' | 'actor-key' | 'webfinger' | 'backend' | 'followers' | 'inbox-refusals'

/**
 * One diagnostic. A check that can fail has `ok`; one that only reports a number has `value`.
 *
 * @remarks
 * `code` names the failing condition, stable for a client: the page shows the fix text of
 * `docs/operate/configure.md` that belongs to it.
 */
export interface Diagnostic {
  id: DiagnosticId
  /** `null` for a figure that is not a pass or a fail. */
  ok: boolean | null
  /** Why it fails, when `ok` is false. */
  code: DiagnosticFailure | null
  /** The figure or the name that is reported: a count, or the backend in use. */
  value: string | number | null
}

/** The failing conditions the diagnostics tell apart. */
export type DiagnosticFailure =
  | 'url-missing'
  | 'url-not-https'
  | 'actor-key-unreadable'
  | 'actor-key-missing'
  | 'actor-key-missing-encryption-key'
  | 'webfinger-skipped'
  | 'webfinger-unreachable'
  | 'webfinger-not-found'
  | 'webfinger-wrong-subject'

/** What `POST /fediverse-panel/failures/:documentId/retry` answers (202). */
export interface RetryResult {
  /** What was sent again; a failed `Delete` goes out as a `Delete`. */
  activity: 'Create' | 'Update' | 'Delete'
  /** Followers it was queued for. */
  queued: number
  /** Followers left out because their inbox is gone. */
  skipped: number
}

/** A row of the followers table. The remote user is named only by what the row stores. */
export interface FollowerRow {
  documentId: string
  handle: string | null
  name: string | null
  /** When the follow was recorded. */
  since: string
  blocked: boolean
  unreachableSince: string | null
}

/** A failed delivery: the article and what went wrong. */
export interface FailureRow {
  articleDocumentId: string
  /** Title of the article in the default locale, `null` when it no longer exists. */
  title: string | null
  lastActivityType: 'Create' | 'Update' | 'Delete' | null
  lastActivityAt: string | null
  attempts: number
  lastError: string | null
}
