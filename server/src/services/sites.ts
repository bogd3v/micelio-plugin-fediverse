import type { Core } from '@strapi/strapi'

import { SITE_UID } from '../constants/uids'

/** The `where` fragment that limits a query of a site-scoped type to one site's rows. */
export function inSite(site: string): { site: { documentId: string } } {
  return { site: { documentId: site } }
}

/**
 * The `documentId` of the default site (the row with `isDefault`), the site whose actor the plugin
 * serves: the inbox, the queue and the events of the plugin act for it.
 *
 * @throws `Error` when no site exists yet. After the boot there is always one: the core creates it.
 */
export async function defaultSite(strapi: Core.Strapi): Promise<string> {
  const row = (await strapi.db.query(SITE_UID).findOne({
    where: { isDefault: true },
    select: ['documentId'],
  })) as { documentId: string } | null
  if (row == null) throw new Error('[fediverse] there is no default site yet')
  return row.documentId
}

/**
 * The site a service acts for: the one it was given, else the default site. A service takes the
 * site as its last, optional argument so that the single-site callers (the inbox, the queue, the
 * events of the plugin) need not name it: with one site everything resolves to the default one.
 */
export async function resolveSite(strapi: Core.Strapi, site?: string): Promise<string> {
  return site ?? (await defaultSite(strapi))
}

/**
 * The `documentId` of the site a request is for: the one the core's route middleware left in
 * `ctx.state.micelio.site` (content API routes), else the one whose `slug` the `site` query
 * parameter names (admin routes), else the default site.
 *
 * @returns `null` when the request names a slug no site has.
 */
export async function siteOfRequest(
  strapi: Core.Strapi,
  ctx: { state?: unknown; query?: Record<string, unknown> }
): Promise<string | null> {
  const scoped = (ctx.state as { micelio?: { site?: { documentId?: string } } } | undefined)
    ?.micelio?.site?.documentId
  if (typeof scoped === 'string') return scoped
  const slug = ctx.query?.site
  if (slug === undefined) return defaultSite(strapi)
  if (typeof slug !== 'string') return null
  const row = (await strapi.db.query(SITE_UID).findOne({
    where: { slug },
    select: ['documentId'],
  })) as { documentId: string } | null
  return row?.documentId ?? null
}

/**
 * The `id` of one row of a site, which the `site` relation of a new row points at. A site has a
 * row per locale and they share the `documentId`; the relation is not localised, so any row does.
 *
 * @throws `Error` when the site does not exist.
 */
export async function siteRowId(strapi: Core.Strapi, site: string): Promise<number> {
  const row = (await strapi.db.query(SITE_UID).findOne({
    where: { documentId: site },
    select: ['id'],
    orderBy: { id: 'asc' },
  })) as { id: number } | null
  if (row == null) throw new Error('[fediverse] the site does not exist')
  return row.id
}
