import { createRequire } from 'node:module'

// The core is loaded as CommonJS, as Strapi loads it (see ./fediverse-profile.ts).
const { SITE_UID } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

const CATEGORY_UID = 'plugin::micelio.category'

/** A relation value that names the default site by the id of its row. */
async function defaultSiteRelation(): Promise<{ id: number }> {
  const site = (await strapi.db.query(SITE_UID).findOne({
    where: { isDefault: true },
    select: ['id'],
  })) as { id: number } | null
  if (!site) throw new Error('There is no default site: the core plugin creates it at boot')
  return { id: site.id }
}

/**
 * Creates the categories `ia` and `linux` in every enabled locale, so an article of either
 * language can name them. Call it after `setupStrapi()` and after the locales are created.
 */
async function createCategories(): Promise<void> {
  const locales = (await strapi.plugin('i18n').service('locales').find()) as { code: string }[]
  const site = await defaultSiteRelation()
  for (const slug of ['ia', 'linux']) {
    const created = await strapi
      .documents(CATEGORY_UID)
      .create({ data: { name: slug, slug, site } as never })
    for (const { code } of locales) {
      if (code === created.locale) continue
      await strapi
        .documents(CATEGORY_UID)
        .update({ documentId: created.documentId, locale: code, data: { name: slug } as never })
    }
  }
}

export { createCategories, defaultSiteRelation }
