import { createRequire } from 'node:module'

// The core is loaded as CommonJS, as Strapi loads it: its ESM build imports lodash's named exports,
// which Node's ESM loader cannot resolve.
const { SITE_UID } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

/** The default site's `documentId` (the row with `isDefault`, which the core creates at boot). */
async function defaultSiteId(): Promise<string> {
  const site = (await strapi.db.query(SITE_UID).findOne({
    where: { isDefault: true },
    select: ['documentId'],
  })) as { documentId: string } | null
  return site!.documentId
}

/**
 * Updates the default site (`plugin::micelio.site`, default locale), where the actor's profile and
 * the object type are read from. Call it after `setupStrapi()`.
 */
export async function updateDefaultSite(
  data: Record<string, unknown>,
  locale?: string
): Promise<unknown> {
  return strapi
    .documents(SITE_UID)
    .update({ documentId: await defaultSiteId(), data, ...(locale ? { locale } : {}) } as never)
}

/** Sets the `fediverse` component of the default site; `null` empties it. */
export async function writeFediverseProfile(
  fediverse: Record<string, unknown> | null
): Promise<unknown> {
  return updateDefaultSite({ fediverse })
}

/**
 * Sets the handle's `@user` in the default site's `fediverse` component, where
 * `FEDIVERSE_ACTOR_USERNAME` used to put it. Call it after `setupStrapi()`.
 */
export async function setFediverseUsername(username: string): Promise<void> {
  await writeFediverseProfile({ username })
}
