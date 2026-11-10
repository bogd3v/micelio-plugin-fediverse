import type { Core } from '@strapi/strapi'

import { DEFAULT_OBJECT_TYPE } from '../constants/object-type'
import { SITE_UID } from '../constants/uids'
import type { FederatedObjectType } from '../types/articles'
import { resolveSite } from './sites'

/**
 * The type articles are sent as: `fediverse.objectType` of the site, read on every call so a
 * change needs no restart. Falls back to the `Note` default when the setting is empty, unknown or
 * cannot be read, so a site that never chose sends `Note` (#305).
 *
 * @param site - The site's `documentId`; the default site when omitted.
 */
export async function getObjectType(
  strapi: Core.Strapi,
  site?: string
): Promise<FederatedObjectType> {
  try {
    const settings = (await strapi.documents(SITE_UID).findOne({
      documentId: await resolveSite(strapi, site),
      populate: { fediverse: true },
    })) as { fediverse?: { objectType?: string | null } | null } | null
    return settings?.fediverse?.objectType === 'article' ? 'article' : DEFAULT_OBJECT_TYPE
  } catch (error) {
    strapi.log.warn('[fediverse] failed to load the object type from the site', {
      error,
    })
    return DEFAULT_OBJECT_TYPE
  }
}
