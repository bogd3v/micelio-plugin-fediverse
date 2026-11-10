import { createRequire } from 'node:module'

import type { Core, Modules } from '@strapi/strapi'

import { SECTION_ATTRIBUTE } from '../constants/site-actor'
import { FOLLOWER_UID, SITE_UID } from '../constants/uids'
import type { FederationProblemCode } from '../types/federation-panel'
import { actorSiteOf, listActorSites } from './actor-sites'
import { sendProblem } from '../utils/problem'
import { inSite } from './sites'

/** The codes of the two locks, which the HTTP layer answers as a `409` problem detail. */
export type SiteLockCode = Extract<
  FederationProblemCode,
  'username-locked' | 'identifier-locked' | 'identifier-taken'
>

/** The name `isSiteLockError` reads in the body Strapi gives a refused write. */
export const SITE_LOCK_ERROR = 'SiteLockedError'

/**
 * The `ApplicationError` class of the Strapi that runs the plugin. Strapi's error handler tells
 * its errors by `instanceof`, so the class must be the one Strapi's core loads: another copy of
 * `@strapi/utils` (a host can have two versions) would be answered as a `500`. It is found from
 * `@strapi/strapi` and `@strapi/core`, the way Strapi itself resolves it.
 */
function applicationErrorClass(): new (message: string, details: object) => Error {
  const fromStrapi = createRequire(require.resolve('@strapi/strapi'))
  const fromCore = createRequire(fromStrapi.resolve('@strapi/core'))
  return (fromCore('@strapi/utils') as typeof import('@strapi/utils')).errors.ApplicationError
}

/**
 * A write to a site that the plugin refuses. Strapi answers an `ApplicationError` as `400`; the
 * middleware of `mountSiteLockProblems` turns it into the `409` problem detail with this `code`.
 */
function siteLockedError(code: SiteLockCode, message: string): Error {
  const Base = applicationErrorClass()
  const error = new Base(message, { code })
  error.name = SITE_LOCK_ERROR
  return error
}

interface ComponentWrite {
  id?: number | string
  [key: string]: unknown
}

interface SiteWrite {
  fediverse?: ComponentWrite | null
  [SECTION_ATTRIBUTE]?: ComponentWrite | null
}

const IDENTIFIER_TAKEN =
  'Another site already has this actor identifier: each actor needs its own path'

const blank = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * The value a field has after a write of its component. Strapi's Document Service updates a
 * component in place only when the value carries the component's `id`; without one it replaces the
 * instance, and every field left out becomes empty. So a write with no `id` that leaves the field
 * out empties it, and the locks must see that.
 */
function afterWrite(current: string, write: ComponentWrite | null, field: string): string {
  if (write == null) return ''
  if (field in write) return blank(write[field])
  return write.id === undefined ? '' : current
}

/**
 * Document Service middleware on `plugin::micelio.site`: refuses an update that changes the
 * handle's `username` of a site whose actor has a follower row, one that changes an actor
 * `identifier` already set, and one that gives a site an identifier another site has. Remote
 * servers key a follower by the actor's id and show its handle: neither can move without losing
 * the followers.
 *
 * @remarks
 * The lock is this middleware, not a Content Manager permission: any role that can update `Site`
 * can edit the fields, and the middleware runs whoever writes. A follower row of any kind counts,
 * blocked ones included. A write counts by what it leaves, not by the keys it names: see
 * {@link afterWrite}.
 */
export function siteLocks(strapi: Core.Strapi): Modules.Documents.Middleware.Middleware {
  return async (context, next) => {
    if (context.uid !== SITE_UID) return next()
    const params = context.params as unknown as { documentId?: string; data?: SiteWrite }
    const data = params.data
    if (context.action === 'create') {
      // A new site cannot take an identifier another site has.
      const asked = data?.[SECTION_ATTRIBUTE]
      if (asked && (await identifierVerdict(strapi, undefined, data)) === 'taken') {
        throw siteLockedError('identifier-taken', IDENTIFIER_TAKEN)
      }
      return next()
    }
    if (context.action !== 'update' || !data || !params.documentId) return next()

    if ('fediverse' in data && (await changesUsername(strapi, params.documentId, data))) {
      throw siteLockedError(
        'username-locked',
        "The username cannot change while the site's actor has followers: they would lose the handle they follow"
      )
    }
    if (SECTION_ATTRIBUTE in data) {
      const verdict = await identifierVerdict(strapi, params.documentId, data)
      if (verdict === 'changed') {
        throw siteLockedError(
          'identifier-locked',
          "The actor identifier cannot change once set: remote servers key the site's followers by it"
        )
      }
      if (verdict === 'taken') {
        throw siteLockedError('identifier-taken', IDENTIFIER_TAKEN)
      }
    }
    return next()
  }
}

async function changesUsername(
  strapi: Core.Strapi,
  documentId: string,
  data: SiteWrite
): Promise<boolean> {
  const row = (await strapi.db.query(SITE_UID).findOne({
    where: { documentId },
    populate: { fediverse: true },
    orderBy: { id: 'asc' },
  })) as { fediverse?: { username?: unknown } | null } | null
  const identifier = (await actorSiteOf(strapi, documentId))?.identifier ?? ''
  // What the handle is: the username, else the identifier (see `getActorUsername`).
  const before = blank(row?.fediverse?.username) || identifier
  const after = afterWrite(blank(row?.fediverse?.username), data.fediverse ?? null, 'username')
  if ((after || identifier) === before) return false
  return (await strapi.db.query(FOLLOWER_UID).count({ where: inSite(documentId) })) > 0
}

/**
 * Whether a write gives the site an identifier it may not have. `documentId` is `undefined` for a
 * site being created.
 *
 * @remarks
 * "Set" means set in the stored section. The default site's `FEDIVERSE_ACTOR_IDENTIFIER` stands in
 * for an empty section (until the boot step writes it), so there the only change refused is to a
 * value other than that one; saving the section still empty, as the Content Manager does with
 * the whole document, is no change.
 */
async function identifierVerdict(
  strapi: Core.Strapi,
  documentId: string | undefined,
  data: SiteWrite
): Promise<'ok' | 'changed' | 'taken'> {
  const sites = await listActorSites(strapi)
  const effective = sites.find((site) => site.documentId === documentId)?.identifier ?? null
  const stored = documentId
    ? ((await strapi.db.query(SITE_UID).findOne({
        where: { documentId },
        populate: { [SECTION_ATTRIBUTE]: true },
        orderBy: { id: 'asc' },
      })) as { [SECTION_ATTRIBUTE]?: { identifier?: unknown } | null } | null)
    : null
  const current = blank(stored?.[SECTION_ATTRIBUTE]?.identifier)
  const after = afterWrite(current, data[SECTION_ATTRIBUTE] ?? null, 'identifier')
  if (current !== '' && after !== current) return 'changed'
  if (current === '' && effective != null && after !== '' && after !== effective) return 'changed'
  const taken =
    after !== '' && sites.some((s) => s.documentId !== documentId && s.identifier === after)
  return taken ? 'taken' : 'ok'
}

/**
 * Koa middleware that turns the refusal of a lock into a problem detail. Strapi's error handler
 * runs inside it and has already written the `ApplicationError` as a `400` envelope; the `409`
 * and the RFC 9457 body replace it.
 */
export function mountSiteLockProblems(): (
  ctx: { status: number; type: string; body: unknown },
  next: () => Promise<unknown>
) => Promise<void> {
  return async (ctx, next) => {
    await next()
    const error = (ctx.body as { error?: { name?: string; message?: string; details?: unknown } })
      ?.error
    if (error?.name !== SITE_LOCK_ERROR) return
    const code = (error.details as { code?: SiteLockCode } | undefined)?.code
    if (code) sendProblem(ctx, 409, code, error.message ?? '')
  }
}
