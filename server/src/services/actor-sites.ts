import type { Core } from '@strapi/strapi'

import { ACTOR_IDENTIFIER } from '../constants/actor'
import { SECTION_ATTRIBUTE } from '../constants/site-actor'
import { SITE_UID } from '../constants/uids'
import { publicOrigin } from '../utils/public-origin'

/** A site as the actor paths need it. */
export interface ActorSite {
  documentId: string
  slug: string
  isDefault: boolean
  /** The site's hosts, lower case and without port; the first is the handle host. */
  hosts: string[]
  /**
   * The actor's path segment (`/fediverse/user/<identifier>`), or `null` when the site has none:
   * the `identifier` of its `fediverse-actor` section, and for the default site, until the boot
   * step has filled it, `FEDIVERSE_ACTOR_IDENTIFIER`.
   */
  identifier: string | null
}

interface SiteRow {
  documentId: string
  slug: string
  isDefault: boolean | null
  hosts: unknown
  [SECTION_ATTRIBUTE]?: { identifier?: string | null } | null
}

function hostsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((host): host is string => typeof host === 'string' && host !== '')
    : []
}

/**
 * Every site, once, in creation order. A site has a row per locale; the section and the hosts are
 * not localised, so the first row that has them speaks for the site.
 */
export async function listActorSites(strapi: Core.Strapi): Promise<ActorSite[]> {
  const rows = (await strapi.db.query(SITE_UID).findMany({
    select: ['documentId', 'slug', 'isDefault', 'hosts'],
    populate: { [SECTION_ATTRIBUTE]: true },
    orderBy: { id: 'asc' },
  })) as SiteRow[]

  const sites = new Map<string, ActorSite>()
  for (const row of rows) {
    const identifier = row[SECTION_ATTRIBUTE]?.identifier?.trim() || null
    const known = sites.get(row.documentId)
    if (known) {
      known.identifier ??= identifier
      if (known.hosts.length === 0) known.hosts = hostsOf(row.hosts)
      continue
    }
    sites.set(row.documentId, {
      documentId: row.documentId,
      slug: row.slug,
      isDefault: row.isDefault === true,
      hosts: hostsOf(row.hosts),
      identifier,
    })
  }
  // The default site's variable stands in until the boot step writes it to the section.
  for (const site of sites.values()) {
    if (site.isDefault) site.identifier ||= ACTOR_IDENTIFIER || null
  }
  return [...sites.values()]
}

/** The site whose actor has this identifier, or `null`. */
export async function siteByIdentifier(
  strapi: Core.Strapi,
  identifier: string
): Promise<ActorSite | null> {
  return (await listActorSites(strapi)).find((site) => site.identifier === identifier) ?? null
}

/** The site with this `documentId`, or `null`. */
export async function actorSiteOf(
  strapi: Core.Strapi,
  documentId: string
): Promise<ActorSite | null> {
  return (await listActorSites(strapi)).find((site) => site.documentId === documentId) ?? null
}

/** The default site (the row with `isDefault`), or `null` while there is none. */
export async function defaultActorSite(strapi: Core.Strapi): Promise<ActorSite | null> {
  return (await listActorSites(strapi)).find((site) => site.isDefault) ?? null
}

/**
 * The site a handle host belongs to: the one that lists it in `hosts`, else, for a site with no
 * hosts, the host of `URL` (the default site's). With `URL` unset every host reaching this point is
 * the request's own, which Fedify already checked, so the default site answers for it.
 *
 * @param host - The host of the `acct:` resource, lower case, with its port if it has one.
 */
export async function siteByHandleHost(
  strapi: Core.Strapi,
  host: string
): Promise<ActorSite | null> {
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  const sites = await listActorSites(strapi)
  const listed = sites.find((site) => site.hosts.includes(hostname))
  if (listed) return listed
  const origin = publicOrigin()
  const fallbackFor = origin == null || new URL(origin).hostname === hostname
  return fallbackFor
    ? (sites.find((site) => site.isDefault && site.hosts.length === 0) ?? null)
    : null
}

/**
 * The host of a site's handle: the first of its hosts, else the host of `URL` (the CMS), else the
 * host of the given origin.
 */
export function handleHostOf(site: Pick<ActorSite, 'hosts'>, origin: string): string {
  const configured = publicOrigin()
  return site.hosts[0] ?? new URL(configured ?? origin).host
}

/** Whether a host is one of the hosts of a site: used to decide who may rewrite a WebFinger host. */
export async function isSiteHost(strapi: Core.Strapi, host: string): Promise<boolean> {
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  return (await listActorSites(strapi)).some((site) => site.hosts.includes(hostname))
}

/**
 * The identifier of the default site's actor: the one that signs what the plugin sends for the
 * articles and the replies. `FEDIVERSE_ACTOR_IDENTIFIER` until the boot step has written it.
 */
export async function defaultIdentifier(strapi: Core.Strapi): Promise<string> {
  return (await defaultActorSite(strapi))?.identifier ?? ACTOR_IDENTIFIER
}
