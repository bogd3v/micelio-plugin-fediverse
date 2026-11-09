import type { FederationProblemCode } from '../types/federation-panel'

/** Media type of an RFC 9457 problem detail. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8'

/** The RFC 9457 body the admin routes answer an error with; a client branches on `code`. */
export interface ProblemBody {
  type: 'about:blank'
  title: string
  status: number
  detail: string
  code: FederationProblemCode
}

/** Builds a problem detail body (RFC 9457) with a stable `code` extension member. */
export function problemBody(
  status: number,
  code: FederationProblemCode,
  title: string,
  detail: string
): ProblemBody {
  return { type: 'about:blank', title, status, detail, code }
}

const TITLES: Record<FederationProblemCode, string> = {
  'article-not-found': 'Article not found',
  forbidden: 'Not allowed',
  'article-not-published': 'Article not published',
  'locale-not-federated': 'Locale not federated',
  'queue-unavailable': 'Delivery queue unavailable',
  'follower-not-found': 'Follower not found',
  'not-failed': 'Nothing to retry',
}

/** The part of a Koa context that answering a problem detail needs. */
export interface ProblemContext {
  status: number
  type: string
  body: unknown
}

/** Answers `ctx` with a problem detail: status, `application/problem+json` and the body. */
export function sendProblem(
  ctx: ProblemContext,
  status: number,
  code: FederationProblemCode,
  detail: string
): void {
  ctx.status = status
  ctx.body = problemBody(status, code, TITLES[code], detail)
  // After the body: assigning an object sets the type to plain JSON.
  ctx.type = PROBLEM_CONTENT_TYPE
}
