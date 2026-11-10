import type { Core } from '@strapi/strapi'
import type { MicelioExtensions } from '@micelio/strapi-plugin-core/strapi-server'

/**
 * The core's `extensions` service. Taken from the service, not from a property of the plugin:
 * Strapi does not order plugins, and the service exists from the start.
 */
export function extensionsOf(strapi: Core.Strapi): MicelioExtensions {
  return strapi.plugin('micelio').service('extensions') as MicelioExtensions
}
