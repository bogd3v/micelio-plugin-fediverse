import type { Core } from '@strapi/strapi'

/**
 * Registers the plugin's two permissions, so roles can be given them in Settings → Roles
 * (the super admin has them at once). The page shows its menu entry, and the routes answer,
 * only to a role that has `read`; `manage` is the right to change anything.
 */
export async function registerPermissionActions(strapi: Core.Strapi): Promise<void> {
  await strapi.service('admin::permission').actionProvider.registerMany([
    {
      section: 'plugins',
      displayName: 'Read the Fediverse page: diagnostics, followers and failures',
      uid: 'read',
      pluginName: 'fediverse',
    },
    {
      section: 'plugins',
      displayName: 'Block and unblock followers, and retry failed deliveries',
      uid: 'manage',
      pluginName: 'fediverse',
    },
  ])
}
