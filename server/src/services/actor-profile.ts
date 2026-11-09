import type { Core } from '@strapi/strapi'

import { ACTOR_IDENTIFIER } from '../constants/actor'
import { GLOBAL_UID, SITE_UID } from '../constants/uids'
import type { ActorProfile } from '../types/actor-profile'
import { attributionDomains } from '../utils/attribution-domains'
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

/**
 * Reads the default site (the row with `isDefault`) in the default locale with the component's header
 * populated: the document service does not populate media by itself.
 */
async function loadSiteSettings(strapi: Core.Strapi): Promise<SiteSettings | null> {
  try {
    return (await strapi.documents(SITE_UID).findFirst({
      filters: { isDefault: true },
      populate: { fediverse: { populate: { header: true } } },
    })) as SiteSettings | null
  } catch (error) {
    strapi.log.warn('[fediverse] failed to load the default site for actor profile', { error })
    return null
  }
}

function resolveUsername(settings: SiteSettings | null): string {
  return firstFilled(settings?.fediverse?.username, ACTOR_IDENTIFIER) ?? ''
}

/**
 * The handle's `@user` (`preferredUsername`): the default site's `fediverse.username`, then the
 * actor identifier.
 */
export async function getActorUsername(strapi: Core.Strapi): Promise<string> {
  return resolveUsername(await loadSiteSettings(strapi))
}

/**
 * Usernames WebFinger resolves to the blog, lowercase: the current handle and, as a former
 * handle, the identifier.
 */
export async function getActorUsernames(strapi: Core.Strapi): Promise<string[]> {
  const usernames = [await getActorUsername(strapi), ACTOR_IDENTIFIER]
  return [...new Set(usernames.filter(Boolean).map((username) => username.toLowerCase()))]
}

/**
 * Resolves the blog actor's profile. The `fediverse` component of the default site wins; each
 * empty field falls back, in order, to the site's identity:
 *
 *   username ← fediverse.username → the actor identifier
 *   name     ← fediverse.displayName → global.siteName → site.name → "Micelio"
 *   summary  ← fediverse.summary → global.siteDescription → site.description → none
 *   icon     ← global.favicon (resolved against the actor URL)
 *   header   ← fediverse.header (resolved against the actor URL)
 *   fields   ← Blog (FRONTEND_URL) and Código (fediverse.sourceUrl → this repository)
 *   attributionDomains ← the host of FRONTEND_URL and FEDIVERSE_HANDLE_HOST (utils/attribution-domains.ts)
 *
 * `discoverable` is true unless the component says otherwise. `about.title` is deliberately not
 * a fallback: it's the About page heading ("Acerca de este blog"), not a name. The
 * `FEDIVERSE_ACTOR_*` variables and `global`'s `fediverseHeader` are no longer read (#307).
 */
export async function getActorProfile(strapi: Core.Strapi, baseUrl: string): Promise<ActorProfile> {
  let globalSettings: GlobalSettings | null = null

  try {
    globalSettings = (await strapi.documents(GLOBAL_UID).findFirst({
      populate: { favicon: true },
    })) as GlobalSettings | null
  } catch (error) {
    strapi.log.warn('[fediverse] failed to load global settings for actor profile', { error })
  }

  // The default locale, like every other read of the actor.
  const siteSettings = await loadSiteSettings(strapi)
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

  return {
    username: resolveUsername(siteSettings),
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
    attributionDomains: attributionDomains(),
  }
}

export default (): {
  getActorProfile: typeof getActorProfile
} => ({
  getActorProfile,
})
