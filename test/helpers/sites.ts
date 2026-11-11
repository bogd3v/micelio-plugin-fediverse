import { createRequire } from 'node:module'

// The core is loaded as CommonJS, as Strapi loads it (see `fediverse-profile.ts`).
const { SITE_UID } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

/** The attribute of `plugin::micelio.site` that holds the `fediverse-actor` section. */
export const SECTION = 'section_fediverse_actor'

/** The plugin store entry that records the 0.7 boot step. */
export const CUT_OVER_STORE = { type: 'plugin', name: 'fediverse' } as const
export const CUT_OVER_KEY = 'cut-over-0.7'

interface SiteView {
  documentId: string
  slug: string
  hosts: string[]
  identifier: string | null
  fediverse: Record<string, unknown> | null
}

/** Creates a site that is not the default one, as the core's own suites do. */
export async function createSite(
  slug: string,
  data: Record<string, unknown> = {}
): Promise<string> {
  const site = await strapi.documents(SITE_UID).create({
    data: {
      name: slug,
      slug,
      hosts: [],
      isDefault: false,
      defaultLocale: 'en',
      modules: {},
      ...data,
    } as never,
  })
  return site.documentId
}

/** Reads a site (or the default one) the way the plugin stores it. */
export async function readSite(documentId?: string): Promise<SiteView> {
  const row = (await strapi.db.query(SITE_UID).findOne({
    where: documentId ? { documentId } : { isDefault: true },
    populate: { [SECTION]: true, fediverse: true },
    orderBy: { id: 'asc' },
  })) as Record<string, unknown>
  return {
    documentId: row.documentId as string,
    slug: row.slug as string,
    hosts: (row.hosts as string[] | null) ?? [],
    identifier: (row[SECTION] as { identifier?: string | null } | null)?.identifier ?? null,
    fediverse: (row.fediverse as Record<string, unknown> | null) ?? null,
  }
}

/** Sets the `hosts` of a site (or the default one). */
export async function setHosts(hosts: string[], documentId?: string): Promise<void> {
  const id = documentId ?? (await readSite()).documentId
  await strapi.documents(SITE_UID).update({ documentId: id, data: { hosts } as never })
}

/** The `documentId` of the site with this `slug`. */
export async function siteIdOf(slug: string): Promise<string> {
  const row = (await strapi.db.query(SITE_UID).findOne({
    where: { slug },
    select: ['documentId'],
  })) as { documentId: string }
  return row.documentId
}

/** The members of an answer of the plugin that the suites read. */
export interface JsonBody {
  subject?: string
  links?: { rel: string; href: string }[]
  name?: string
  summary?: string
  id?: string
  type?: string
  preferredUsername?: string
  attributionDomains?: string[]
  totalItems?: number
  orderedItems?: unknown[]
  [key: string]: unknown
}

/** The JSON body of a response, or `{}` when it has none. */
export async function jsonOf(res: Response): Promise<JsonBody> {
  try {
    return (await res.json()) as JsonBody
  } catch {
    return {}
  }
}
