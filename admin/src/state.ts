/** Pure logic of the federation panel: what to say about a state, free of React. */

/** The federation state of one article, as `GET /fediverse-panel/articles/:documentId/federation` answers. */
export interface ArticleFederation {
  documentId: string
  state: 'never' | 'created' | 'updated' | 'deleted' | 'failed'
  lastActivityType: 'Create' | 'Update' | 'Delete' | null
  lastActivityAt: string | null
  createSentAt: string | null
  attempts: number
  lastError: string | null
  counts: { likes: number; boosts: number; repliesApproved: number; repliesPending: number }
  canFederate:
    { allowed: true } | { allowed: false; code: 'locale-not-federated' | 'article-not-published' }
}

/** What `POST …/federate` answers. */
export interface FederateResult {
  activity: 'Create' | 'Update'
  queued: number
  skipped: number
}

/** The colour family of the status badge. */
export type Tone = 'neutral' | 'success' | 'danger'

/** How to present the state: message ids (see `translations/en.json`) and what to show with them. */
export interface StatusView {
  /** The headline. */
  messageId: string
  tone: Tone
  /** An explanation under the headline, if any. */
  detailId: string | null
  /** Whether to show when the last activity was queued. */
  showTime: boolean
  /** Whether to show `lastError`. */
  showError: boolean
}

const BY_STATE: Record<ArticleFederation['state'], StatusView> = {
  never: {
    messageId: 'fediverse.panel.state.never',
    tone: 'neutral',
    detailId: 'fediverse.panel.state.never.detail',
    showTime: false,
    showError: false,
  },
  created: {
    messageId: 'fediverse.panel.state.created',
    tone: 'success',
    detailId: null,
    showTime: true,
    showError: true,
  },
  updated: {
    messageId: 'fediverse.panel.state.updated',
    tone: 'success',
    detailId: null,
    showTime: true,
    showError: true,
  },
  deleted: {
    messageId: 'fediverse.panel.state.deleted',
    tone: 'neutral',
    detailId: null,
    showTime: true,
    showError: false,
  },
  failed: {
    messageId: 'fediverse.panel.state.failed',
    tone: 'danger',
    detailId: 'fediverse.panel.state.failed.detail',
    showTime: true,
    showError: true,
  },
}

/**
 * How the panel presents an article's state. Nothing here says "delivered": the backend only
 * knows an activity was queued, or that a delivery was given up on.
 */
export function statusView(federation: ArticleFederation): StatusView {
  const view = BY_STATE[federation.state]
  // A queued activity whose earlier attempts failed shows why, without calling it a failure yet.
  return view.showError && federation.lastError == null ? { ...view, showError: false } : view
}

/** The hint under "Federate now": which activity it will send. */
export function federateHintId(federation: ArticleFederation): string {
  return federation.state === 'never' || federation.state === 'deleted'
    ? 'fediverse.panel.federate.create'
    : 'fediverse.panel.federate.update'
}

/** The message that says why "Federate now" is disabled, or `null` when it is available. */
export function blockedMessageId(federation: ArticleFederation): string | null {
  return federation.canFederate.allowed
    ? null
    : `fediverse.panel.blocked.${federation.canFederate.code}`
}

/** What a failed request means: show nothing, say federation is off, or offer a retry. */
export type FailureKind = 'hidden' | 'off' | 'error'

/** The fields of an RFC 9457 problem detail the panel reads. */
export interface Problem {
  code?: string
}

/** A response of the panel routes, read from its status and raw body. */
export type PanelResponse<T> =
  { ok: true; data: T } | { ok: false; status: number; problem: Problem | undefined }

/**
 * Reads a response of the panel routes from its status and body text.
 *
 * @remarks
 * The admin fetch client turns an error body without an `error` member, which is what a problem
 * detail is, into a bare `FetchError` that carries only the status. So the panel asks for the body
 * as text, accepts every status, and reads the body itself.
 */
export function interpretResponse<T>(status: number, body: string): PanelResponse<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Koa's plain "Not Found" for a route that does not exist is not JSON.
    return { ok: false, status, problem: undefined }
  }
  if (status >= 200 && status < 300) return { ok: true, data: parsed as T }
  const code = (parsed as { code?: unknown } | null)?.code
  return { ok: false, status, problem: typeof code === 'string' ? { code } : undefined }
}

/**
 * Reads the answer of a `POST` through the admin fetch client.
 *
 * @remarks
 * Unlike its `get`, the client's `post` takes no `responseType`: it parses the body itself and
 * returns only `{ data }`, with no status. With every status accepted, a refusal arrives as the
 * parsed problem detail, which tells itself apart by its `status` (an error) and `code`. A body
 * that is not JSON makes the client throw, which the caller treats as a refusal with no code.
 */
export function interpretPostResponse<T>(data: unknown): PanelResponse<T> {
  const body = data as { status?: unknown; code?: unknown; error?: { status?: unknown } } | null
  // Strapi's own error envelope (an expired session, a rate limit, an uncaught error) has no `code`.
  if (
    body != null &&
    typeof body === 'object' &&
    typeof body.error?.status === 'number' &&
    body.error.status >= 400
  ) {
    return { ok: false, status: body.error.status, problem: undefined }
  }
  if (
    body != null &&
    typeof body === 'object' &&
    typeof body.status === 'number' &&
    body.status >= 400
  ) {
    return {
      ok: false,
      status: body.status,
      problem: typeof body.code === 'string' ? { code: body.code } : undefined,
    }
  }
  return { ok: true, data: data as T }
}

/**
 * What a failed request means for the panel. A `404` with no problem `code` comes from Strapi, not
 * from the route: federation is turned off, the route does not exist.
 */
export function classifyFailure(problem: Problem | undefined, status: number): FailureKind {
  if (problem?.code === 'article-not-found' || problem?.code === 'forbidden') return 'hidden'
  if (status === 404 && problem?.code == null) return 'off'
  return 'error'
}

/** The message that explains a problem `code` to the editor; unknown codes get a generic one. */
export function problemMessageId(code: string | undefined): string {
  const known = [
    'forbidden',
    'article-not-found',
    'article-not-published',
    'locale-not-federated',
    'queue-unavailable',
    'follower-not-found',
    'not-failed',
  ]
  return code != null && known.includes(code)
    ? `fediverse.panel.problem.${code}`
    : 'fediverse.panel.problem.unknown'
}
