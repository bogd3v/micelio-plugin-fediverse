import type { Core } from '@strapi/strapi'

/**
 * Whether `code` is one of the locales configured in the i18n plugin, so an
 * unknown or oversized `locale` is rejected before it reaches a query.
 */
export async function isConfiguredLocale(strapi: Core.Strapi, code: string): Promise<boolean> {
  const locales = (await strapi.plugin('i18n').service('locales').find()) as { code: string }[]
  return locales.some((locale) => locale.code === code)
}
