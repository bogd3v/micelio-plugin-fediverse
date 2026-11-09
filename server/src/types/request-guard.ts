import type { Context } from 'koa'

/**
 * `inbox` is a POST to the shared or a per-actor inbox (signed activity
 * deliveries); `read` is any other federation request (WebFinger, NodeInfo,
 * actor, collections, articles).
 */
export type RequestGuardKind = 'inbox' | 'read'

/**
 * Hook the host app may register as `plugin::fediverse.requestGuard` to act on
 * a federation request before Fedify handles it (e.g. rate limiting). It runs
 * before anything reads the request body.
 *
 * Resolves `true` when the guard has already written the response (e.g. a
 * 429), so the request stops there; `false` to let Fedify handle it.
 */
export type RequestGuard = (ctx: Context, kind: RequestGuardKind) => Promise<boolean>
