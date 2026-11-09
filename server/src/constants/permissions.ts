/** Admin permissions of the plugin page, registered for roles in `services/permissions.ts`. */

/** Open the plugin page and read diagnostics, followers and failures. */
export const PERMISSION_READ = 'plugin::fediverse.read'
/** Block and unblock a follower, and retry a failed delivery. */
export const PERMISSION_MANAGE = 'plugin::fediverse.manage'
