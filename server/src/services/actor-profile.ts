import type { Core } from '@strapi/strapi'

import { ACTOR_IDENTIFIER } from '../constants/actor'
import { SECTION_ATTRIBUTE } from '../constants/site-actor'
import { GLOBAL_UID, SITE_UID } from '../constants/uids'
import type { ActorProfile } from '../types/actor-profile'
import { frontendBaseUrl } from '../utils/frontend-url'

const DEFAULT_NAME = 'Micelio'
// Micelio's own code, not the site's: every instance runs it.
const DEFAULT_SOURCE_URL = 'https://github.com/bogd3v/micelio-cms'

interface Media {
  url?: string | null
}

interface GlobalSettings {
  siteName?: string | null
  siteDescription?: string | null
  favicon?: Media | null
}

/** The `fediverse` component of the default site (`site.fediverse`). */
interface FediverseSettings {
  username?: string | null
  displayName?: string | null
  summary?: string | null
  header?: Media | null
  discoverable?: boolean | null
  sourceUrl?: string | null
}

interface SiteSettings {
  documentId?: string
  hosts?: unknown
  name?: string | null
  description?: string | null
  fediverse?: FediverseSettings | null
}

function absoluteUrl(url: string | null | undefined, baseUrl: string): string | null {
  if (!url) return null
  try {
    return new URL(url, baseUrl).href
  } catch {
    return null
  }
}

function frontendHome(): string {
  return new URL(frontendBaseUrl()).href
}

/** The first of the values that is not empty or only spaces, trimmed. */
function firstFilled(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return null
}

/** A site as read for the profile: the row, and the identifier of its actor. */
interface LoadedSite {
  settings: SiteSettings
  identifier: string
}

/**
 * Reads a site in the default locale with the component's header populated (the document service
 * does not populate media by itself), and the identifier of its actor: the `fediverse-actor`
 * section's, and for the default site, until the boot step has written it,
 * `FEDIVERSE_ACTOR_IDENTIFIER`.
 *
 * @param site - The site's `documentId`; the default site when omitted.
 * @returns `null` when there is no such site or it cannot be read.
 */
async function loadSite(strapi: Core.Strapi, site?: string): Promise<LoadedSite | null> {
  const populate = {
    fediverse: { populate: { header: true } },
    [SECTION_ATTRIBUTE]: true,
  }
  try {
    const row = (
      site
        ? await strapi.documents(SITE_UID).findOne({ documentId: site, populate })
        : await strapi.documents(SITE_UID).findFirst({ filters: { isDefault: true }, populate })
    ) as (SiteSettings & { isDefault?: boolean | null }) | null
    if (row == null) return null
    const section = (row as Record<string, unknown>)[SECTION_ATTRIBUTE] as
      { identifier?: string | null } | null | undefined
    const identifier = firstFilled(section?.identifier) ?? (row.isDefault ? ACTOR_IDENTIFIER : '')
    return { settings: row, identifier }
  } catch (error) {
    strapi.log.warn('[fediverse] failed to load the site for actor profile', { error })
    return null
  }
}

function resolveUsername(settings: SiteSettings | null, identifier: string): string {
  return firstFilled(settings?.fediverse?.username, identifier) ?? ''
}

/**
 * The handle's `@user` (`preferredUsername`) of a site: its `fediverse.username`, then its actor
 * identifier.
 *
 * @param site - The site's `documentId`; the default site when omitted.
 */
export async function getActorUsername(strapi: Core.Strapi, site?: string): Promise<string> {
  const loaded = await loadSite(strapi, site)
  return resolveUsername(loaded?.settings ?? null, loaded?.identifier ?? ACTOR_IDENTIFIER)
}

/**
 * Usernames WebFinger resolves to a site's actor, lowercase: the current handle and, as a former
 * handle, the identifier.
 *
 * @param site - The site's `documentId`; the default site when omitted.
 */
export async function getActorUsernames(strapi: Core.Strapi, site?: string): Promise<string[]> {
  const loaded = await loadSite(strapi, site)
  const identifier = loaded?.identifier ?? (site ? '' : ACTOR_IDENTIFIER)
  const usernames = [resolveUsername(loaded?.settings ?? null, identifier), identifier]
  return [...new Set(usernames.filter(Boolean).map((username) => username.toLowerCase()))]
}

/**
 * Resolves the actor's profile of a site. Its `fediverse` component wins; each empty field falls
 * back, in order, to the site's identity:
 *
 *   username ← fediverse.username → the site's actor identifier
 *   name     ← fediverse.displayName → global.siteName → site.name → "Micelio"
 *   summary  ← fediverse.summary → global.siteDescription → site.description → none
 *   icon     ← global.favicon (resolved against the actor URL)
 *   header   ← fediverse.header (resolved against the actor URL)
 *   fields   ← Blog (FRONTEND_URL) and Código (fediverse.sourceUrl → this repository)
 *   attributionDomains ← every entry of the site's `hosts`
 *
 * `discoverable` is true unless the component says otherwise. `about.title` is deliberately not
 * a fallback: it's the About page heading ("Acerca de este blog"), not a name.
 *
 * @param site - The site's `documentId`; the default site when omitted.
 */
export async function getActorProfile(
  strapi: Core.Strapi,
  baseUrl: string,
  site?: string
): Promise<ActorProfile> {
  let globalSettings: GlobalSettings | null = null

  try {
    globalSettings = (await strapi.documents(GLOBAL_UID).findFirst({
      populate: { favicon: true },
    })) as GlobalSettings | null
  } catch (error) {
    strapi.log.warn('[fediverse] failed to load global settings for actor profile', { error })
  }

  const loaded = await loadSite(strapi, site)
  const siteSettings = loaded?.settings ?? null
  const fediverse = siteSettings?.fediverse

  const url = frontendHome()
  const name =
    firstFilled(fediverse?.displayName, globalSettings?.siteName, siteSettings?.name) ??
    DEFAULT_NAME
  const summary = firstFilled(
    fediverse?.summary,
    globalSettings?.siteDescription,
    siteSettings?.description
  )
  const sourceUrl = firstFilled(fediverse?.sourceUrl) ?? DEFAULT_SOURCE_URL
  const hosts = Array.isArray(siteSettings?.hosts) ? (siteSettings.hosts as unknown[]) : []

  return {
    username: resolveUsername(siteSettings, loaded?.identifier ?? ''),
    name,
    summary,
    iconUrl: absoluteUrl(globalSettings?.favicon?.url, baseUrl),
    headerUrl: absoluteUrl(fediverse?.header?.url, baseUrl),
    discoverable: fediverse?.discoverable ?? true,
    url,
    fields: [
      { name: 'Blog', url },
      { name: 'Código', url: sourceUrl },
    ],
    attributionDomains: [
      ...new Set(
        hosts
          .filter((host): host is string => typeof host === 'string')
          .map((host) => host.toLowerCase().replace(/:\d+$/, ''))
          .filter(Boolean)
      ),
    ],
  }
}

export default (): {
  getActorProfile: typeof getActorProfile
} => ({
  getActorProfile,
})
