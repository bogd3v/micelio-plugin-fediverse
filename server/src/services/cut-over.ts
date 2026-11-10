import type { Core } from '@strapi/strapi'

import { ACTOR_IDENTIFIER } from '../constants/actor'
import { CUT_OVER_KEY, CUT_OVER_STORE, SECTION_ATTRIBUTE } from '../constants/site-actor'
import { SITE_UID } from '../constants/uids'
import { publicOrigin } from '../utils/public-origin'
import { listActorSites, type ActorSite } from './actor-sites'

const HANDLE_HOST_VARIABLE = 'FEDIVERSE_HANDLE_HOST'

/** A host such as `example.com`: lower case, no scheme, port or path. */
function bareHost(value: string): string | null {
  const host = value.trim().toLowerCase()
  if (!host) return null
  try {
    return new URL(`https://${host}/`).hostname === host ? host : null
  } catch {
    return null
  }
}

/**
 * The host of the handle on 0.6, `H`, and the name of what it came from: `FEDIVERSE_HANDLE_HOST`,
 * else the host of `URL`. `null` when neither is set: there is no stable host to keep.
 *
 * @throws `Error` naming `FEDIVERSE_HANDLE_HOST` when it is not a bare host.
 */
function previousHandleHost(): { host: string; source: string } | null {
  const configured = process.env[HANDLE_HOST_VARIABLE]?.trim()
  if (configured) {
    const host = bareHost(configured)
    if (host == null) {
      throw new Error(
        `[fediverse] ${HANDLE_HOST_VARIABLE} must be a host such as "example.com", without a scheme, a port or a path (got "${configured}")`
      )
    }
    return { host, source: HANDLE_HOST_VARIABLE }
  }
  const origin = publicOrigin()
  return origin ? { host: new URL(origin).hostname, source: 'URL' } : null
}

/** The host of `FRONTEND_URL` when the operator set it: the development default is no site's domain. */
function frontendHost(): string | null {
  const value = process.env.FRONTEND_URL?.trim()
  if (!value) return null
  try {
    return new URL(value).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

function holder(sites: ActorSite[], site: ActorSite, host: string): ActorSite | undefined {
  return sites.find((other) => other.documentId !== site.documentId && other.hosts.includes(host))
}

/**
 * The hosts the default site should have after the step: `H` pinned first (it fills an empty list
 * or moves to the front of a filled one), the host of `FRONTEND_URL` last when it is missing.
 *
 * @throws `Error` naming `FEDIVERSE_HANDLE_HOST` (or `URL`) when another site holds `H`.
 */
function pinnedHosts(strapi: Core.Strapi, sites: ActorSite[], site: ActorSite): string[] {
  const previous = previousHandleHost()
  let hosts = [...site.hosts]
  if (previous) {
    if (holder(sites, site, previous.host)) {
      throw new Error(
        `[fediverse] ${previous.source} names "${previous.host}", which another site already has as a host: that host was this site's handle host before 0.7, and it cannot be shared. Remove it from the other site's hosts, then boot again`
      )
    }
    hosts = [previous.host, ...hosts.filter((host) => host !== previous.host)]
  }
  const frontend = frontendHost()
  if (frontend && !hosts.includes(frontend)) {
    if (holder(sites, site, frontend)) {
      strapi.log.info(
        `[fediverse] the host of FRONTEND_URL ("${frontend}") belongs to another site, so it is not added to this site's hosts`
      )
    } else {
      hosts.push(frontend)
    }
  }
  return hosts
}

/** Writes `data` to the site, in its default locale (the section and the hosts are not localised). */
async function updateSite(strapi: Core.Strapi, documentId: string, data: object): Promise<void> {
  await strapi.documents(SITE_UID).update({ documentId, data } as never)
}

/**
 * Sets the `identifier` of each site that has none: the default site's from
 * `FEDIVERSE_ACTOR_IDENTIFIER`, any other site's from its `slug`. Never changes one that is set,
 * and never gives a site an identifier another site has (it logs a warning and leaves it empty).
 *
 * @returns How many identifiers it wrote.
 */
export async function ensureIdentifiers(strapi: Core.Strapi, only?: string): Promise<number> {
  let written = 0
  const sites = await listActorSites(strapi)
  for (const site of sites) {
    if (only && site.documentId !== only) continue
    const stored = (await strapi.db.query(SITE_UID).findOne({
      where: { documentId: site.documentId },
      populate: { [SECTION_ATTRIBUTE]: true },
      orderBy: { id: 'asc' },
    })) as { [SECTION_ATTRIBUTE]?: { identifier?: string | null } | null } | null
    if (stored?.[SECTION_ATTRIBUTE]?.identifier?.trim()) continue
    const identifier = site.isDefault ? ACTOR_IDENTIFIER : site.slug
    if (!identifier) continue
    if (
      sites.some((other) => other.documentId !== site.documentId && other.identifier === identifier)
    ) {
      strapi.log.warn(
        `[fediverse] the site "${site.slug}" has no actor: its identifier "${identifier}" is another site's. Set a different one under Fediverse actor`
      )
      continue
    }
    await updateSite(strapi, site.documentId, { [SECTION_ATTRIBUTE]: { identifier } })
    written += 1
  }
  return written
}

/**
 * The 0.7 boot step, once: gives the default site its actor `identifier` (`FEDIVERSE_ACTOR_IDENTIFIER`)
 * and pins the handle host 0.6 served as the first of its `hosts`, so no handle moves; then writes
 * the marker `plugin_fediverse` / `cut-over-0.7`. A boot that finds the marker does nothing but
 * log a warning when `FEDIVERSE_HANDLE_HOST` is still set.
 *
 * @remarks
 * Strapi does not order plugins, so this may run before the core has created the default site;
 * then it does nothing, writes no marker, and the next boot (or the `siteCreated` hook of the
 * default site) runs it. Everything is decided before anything is written, so a boot it stops
 * leaves the site as it was.
 *
 * @throws `Error` naming `FEDIVERSE_HANDLE_HOST` (or `URL`) when another site holds the 0.6
 * handle host: the boot stops.
 */
export async function runCutOver(strapi: Core.Strapi): Promise<void> {
  const store = strapi.store(CUT_OVER_STORE)
  if (await store.get({ key: CUT_OVER_KEY })) {
    if (process.env[HANDLE_HOST_VARIABLE]?.trim()) {
      strapi.log.warn(
        `[fediverse] ${HANDLE_HOST_VARIABLE} is ignored since 0.7: the handle host is the first of the site's hosts. Remove the variable`
      )
    }
    return
  }

  const sites = await listActorSites(strapi)
  const site = sites.find((candidate) => candidate.isDefault)
  if (site == null) return

  const hosts = pinnedHosts(strapi, sites, site)
  if (JSON.stringify(hosts) !== JSON.stringify(site.hosts)) {
    await updateSite(strapi, site.documentId, { hosts })
    strapi.log.info(`[fediverse] the default site's hosts are now ${hosts.join(', ')}`)
  }
  await ensureIdentifiers(strapi)
  await store.set({ key: CUT_OVER_KEY, value: true })
}

export default (): { runCutOver: typeof runCutOver } => ({ runCutOver })
