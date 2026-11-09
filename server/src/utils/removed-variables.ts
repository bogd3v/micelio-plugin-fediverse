/** `FEDIVERSE_ACTOR_*` variables replaced by the `fediverse` component of the default site (#303, #307, #416). */
const REMOVED_ACTOR_VARIABLES = [
  ['FEDIVERSE_ACTOR_USERNAME', 'Username'],
  ['FEDIVERSE_ACTOR_NAME', 'Display name'],
  ['FEDIVERSE_ACTOR_SUMMARY', 'Summary'],
  ['FEDIVERSE_ACTOR_SOURCE_URL', 'Source URL'],
] as const

/**
 * Stops the boot when a removed `FEDIVERSE_ACTOR_*` variable is set, naming the field of the default site that
 * replaces each. A blank value counts as unset. The variables stopped being read in 0.7: setting
 * one would otherwise change nothing and look as if it worked.
 *
 * @throws When any of `FEDIVERSE_ACTOR_USERNAME`, `_NAME`, `_SUMMARY` or `_SOURCE_URL` is set.
 */
export function assertNoRemovedActorVariables(env: NodeJS.ProcessEnv = process.env): void {
  const set = REMOVED_ACTOR_VARIABLES.filter(([name]) => env[name]?.trim())
  if (set.length === 0) return
  const lines = set.map(
    ([name, field]) =>
      `${name} is no longer read: set "${field}" under the default site's Fediverse profile (Sites, the entry marked default) instead`
  )
  throw new Error(`[fediverse] ${lines.join('; ')}. Remove the variable from the environment`)
}
