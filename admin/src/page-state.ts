/** Pure logic of the plugin page: what to say about a diagnostic, a follower, a failure. */

/** One diagnostic, as `GET /fediverse-panel/diagnostics` answers. */
export interface Check {
  id: string
  /** `null` for a figure that is not a pass or a fail. */
  ok: boolean | null
  /** The failing condition, when `ok` is false. */
  code: string | null
  value: string | number | null
}

/** A row of the followers table. */
export interface Follower {
  documentId: string
  handle: string | null
  name: string | null
  since: string
  blocked: boolean
  unreachableSince: string | null
}

/** A failed delivery. */
export interface Failure {
  articleDocumentId: string
  title: string | null
  lastActivityType: 'Create' | 'Update' | 'Delete' | null
  lastActivityAt: string | null
  attempts: number
  lastError: string | null
}

/** The message id of a diagnostic's name. */
export function checkLabelId(check: Check): string {
  return `fediverse.page.check.${check.id}`
}

/** The message id of the text that tells how to fix a failing diagnostic, or `null` if it passes. */
export function fixMessageId(check: Check): string | null {
  return check.ok === false && check.code ? `fediverse.page.fix.${check.code}` : null
}

/**
 * How a figure is shown: the backend by its description, anything else as it is.
 *
 * @returns A message id to translate, or the plain text to show.
 */
export function checkValue(check: Check): { messageId: string } | { text: string } | null {
  if (check.value == null) return null
  if (check.id === 'backend') return { messageId: `fediverse.page.backend.${check.value}` }
  return { text: String(check.value) }
}

/** The badge of a follower: blocked beats unreachable beats active. */
export function followerStatus(row: Follower): 'blocked' | 'unreachable' | 'active' {
  if (row.blocked) return 'blocked'
  return row.unreachableSince ? 'unreachable' : 'active'
}

/** What a follower is called: the handle, else the name, else a dash. */
export function followerLabel(row: Follower): string {
  return row.handle ?? row.name ?? '—'
}

/** The title of a failed article, or the message that says it is gone. */
export function failureTitle(row: Failure): { text: string } | { messageId: string } {
  return row.title ? { text: row.title } : { messageId: 'fediverse.page.failures.deleted' }
}
