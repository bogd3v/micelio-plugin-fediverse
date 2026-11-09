import type { Core } from '@strapi/strapi'

import { DEFAULT_OBJECT_TYPE } from '../constants/object-type'
import { SITE_UID } from '../constants/uids'
import type { FederatedObjectType } from '../types/articles'

/**
 * The type articles are sent as: `fediverse.objectType` of the default site, read on every call
 * so a change needs no restart. Falls back to the `Note` default when the setting is empty,
 * unknown or cannot be read, so a site that never chose sends `Note` (#305).
 */
export async function getObjectType(strapi: Core.Strapi): Promise<FederatedObjectType> {
  try {
    const settings = (await strapi.documents(SITE_UID).findFirst({
      filters: { isDefault: true },
      populate: { fediverse: true },
    })) as { fediverse?: { objectType?: string | null } | null } | null
    return settings?.fediverse?.objectType === 'article' ? 'article' : DEFAULT_OBJECT_TYPE
  } catch (error) {
    strapi.log.warn('[fediverse] failed to load the object type from the default site', {
      error,
    })
    return DEFAULT_OBJECT_TYPE
  }
}
