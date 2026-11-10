import type { Core } from '@strapi/strapi'

import { migrateFederatedArticles } from './federated-articles'
import { getActorKeyPairs } from './keys'

// Self-contained on purpose (standard, section 6): this step keeps its own constants, so it keeps
// working on a database written by an earlier version after the rest of the plugin changes.
const SITE_UID = 'plugin::micelio.site'
const SITE_ATTRIBUTE = 'site'
const SITE_SCOPED = [
  'plugin::fediverse.follower',
  'plugin::fediverse.interaction',
  'plugin::fediverse.federated-article',
] as const
const STORE = { type: 'plugin', name: 'fediverse' } as const
/** The key of the one actor key entry written before the sites. */
const LEGACY_KEYS = 'keyPairs'
/** What `adoptDefaultSite` changed; all zero on a database already in the new shape. */
export interface DefaultSiteReport {
  followers: number
  interactions: number
  federatedArticles: number
  /** `1` when the stored actor key was copied to the default site's entry. */
  actorKeys: number
}

const NOTHING: DefaultSiteReport = {
  followers: 0,
  interactions: 0,
  federatedArticles: 0,
  actorKeys: 0,
}

/** Gives every row of a type that has no site the site `id`; how many rows it changed. */
async function linkRows(strapi: Core.Strapi, uid: string, siteId: number): Promise<number> {
  const rows = (await strapi.db.query(uid).findMany({
    where: { [SITE_ATTRIBUTE]: null },
    select: ['id'],
  })) as { id: number }[]
  for (const row of rows) {
    await strapi.db.query(uid).update({ where: { id: row.id }, data: { [SITE_ATTRIBUTE]: siteId } })
  }
  return rows.length
}

/** Copies the stored `keyPairs` to the entry of the site; whether it wrote it. Never overwrites. */
async function copyActorKey(strapi: Core.Strapi, siteDocumentId: string): Promise<boolean> {
  const store = strapi.store(STORE)
  const target = `${LEGACY_KEYS}:${siteDocumentId}`
  if (Array.isArray(await store.get({ key: target }))) return false
  const legacy: unknown = await store.get({ key: LEGACY_KEYS })
  if (!Array.isArray(legacy) || legacy.length === 0) return false
  await store.set({ key: target, value: legacy })
  return true
}

/**
 * Puts what the plugin stored before the sites on the default site: every follower, interaction and
 * federated-article row without a site, and the actor key.
 *
 * @remarks
 * Run at boot and when the default site is created. Strapi does not order plugins, so this may
 * run before the core has created the default site; then there is nothing to give and it does
 * nothing, and the `siteCreated` hook runs it again. Idempotent and name-based: a row that has a
 * site, or a site that has a key entry, is never touched, so a second run changes nothing. The
 * stored key is copied, not moved: the entry from before the sites stays for one release line so a
 * rollback finds it. Logs counts only.
 *
 * @returns How many rows and keys it changed.
 */
export async function adoptDefaultSite(strapi: Core.Strapi): Promise<DefaultSiteReport> {
  const site = (await strapi.db.query(SITE_UID).findOne({
    where: { isDefault: true },
    select: ['id', 'documentId'],
    orderBy: { id: 'asc' },
  })) as { id: number; documentId: string } | null
  if (!site) return NOTHING

  const [followers, interactions, federatedArticles] = [
    await linkRows(strapi, SITE_SCOPED[0], site.id),
    await linkRows(strapi, SITE_SCOPED[1], site.id),
    await linkRows(strapi, SITE_SCOPED[2], site.id),
  ]
  const actorKeys = (await copyActorKey(strapi, site.documentId)) ? 1 : 0
  const report = { followers, interactions, federatedArticles, actorKeys }

  if (followers + interactions + federatedArticles + actorKeys > 0) {
    strapi.log.info(
      `[fediverse] gave the default site ${followers} follower(s), ${interactions} interaction(s), ${federatedArticles} federated article(s) and ${actorKeys} actor key(s)`
    )
  }
  return report
}

/**
 * Turns the ids the plugin store kept before the content type existed into rows of the default
 * site (`migrateFederatedArticles`, which logs its own count). Run next to `adoptDefaultSite`,
 * not inside it: this step is not self-contained, it uses the plugin's current constants.
 * Does nothing while there is no default site.
 */
export async function migrateStoredArticles(strapi: Core.Strapi): Promise<void> {
  const site = (await strapi.db.query(SITE_UID).findOne({
    where: { isDefault: true },
    select: ['documentId'],
  })) as { documentId: string } | null
  if (site) await migrateFederatedArticles(strapi, site.documentId)
}

/**
 * The default site was just created (the `siteCreated` hook): adopt what is stored, and give a
 * fresh instance its actor key entry. A site that is not the default one gets its key on first use.
 *
 * @param site - The new site's `documentId`.
 */
export async function onSiteCreated(
  strapi: Core.Strapi,
  { site, isDefault }: { site: string; isDefault: boolean }
): Promise<void> {
  if (!isDefault) return
  await adoptDefaultSite(strapi)
  await migrateStoredArticles(strapi)
  await getActorKeyPairs(strapi, site)
}

export default (): {
  adoptDefaultSite: typeof adoptDefaultSite
  migrateStoredArticles: typeof migrateStoredArticles
  onSiteCreated: typeof onSiteCreated
} => ({
  adoptDefaultSite,
  migrateStoredArticles,
  onSiteCreated,
})
