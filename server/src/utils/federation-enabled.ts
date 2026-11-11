/**
 * Whether federation is switched on: `FEDIVERSE_ENABLED` is `true` (the reading of Strapi's
 * `env.bool`, which a host used for its `enabled` before the plugin read the switch itself).
 *
 * @remarks
 * Read when the plugin loads. Strapi loads it once per process, after the host's `.env`.
 */
export function federationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEDIVERSE_ENABLED === 'true'
}
