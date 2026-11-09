/** The plugin's admin permissions, registered on the server (`constants/permissions.ts`). */

/** Opens the Fediverse page and reads it. */
export const READ_PERMISSION = { action: 'plugin::fediverse.read', subject: null } as const

/** Blocks and unblocks followers and retries failed deliveries. */
export const MANAGE_PERMISSION = { action: 'plugin::fediverse.manage', subject: null } as const
