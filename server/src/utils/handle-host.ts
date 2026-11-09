import type { FederationOriginOption } from '../types/federation'
import { publicOrigin } from './public-origin'

/**
 * The host of the fediverse handle (`FEDIVERSE_HANDLE_HOST`), lowercase, or `undefined` when it is
 * unset or the same as the host of `URL` (the handle then stays `@user@<cms host>`).
 *
 * @throws `Error` naming the variable when it is not a bare host (a scheme, path or spaces) or when
 * `URL` is unset, because the web origin the ids keep is `URL`.
 */
export function handleHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.FEDIVERSE_HANDLE_HOST?.trim().toLowerCase()
  if (!value) return undefined

  let host: string | null = null
  try {
    host = new URL(`https://${value}/`).host
  } catch {
    // Reported below with the rest of the invalid values.
  }
  if (host !== value) {
    throw new Error(
      `[fediverse] FEDIVERSE_HANDLE_HOST must be a host such as "example.com", without a scheme or a path (got "${value}")`
    )
  }
  const origin = publicOrigin()
  if (origin == null) {
    throw new Error(
      '[fediverse] FEDIVERSE_HANDLE_HOST needs URL: the ids stay on the CMS origin, which URL names'
    )
  }
  return new URL(origin).host === value ? undefined : value
}

/**
 * The `origin` Fedify is created with: the CMS's public origin (`URL`), and when
 * `FEDIVERSE_HANDLE_HOST` names another host, the handle host next to it. Ids, inbox and key ids
 * are built from the web origin either way, so setting the variable never changes them.
 *
 * @returns `undefined` when `URL` is unset (the request's origin is used, as in development).
 * @throws `Error` as {@link handleHost} does.
 */
export function federationOrigin(
  env: NodeJS.ProcessEnv = process.env
): FederationOriginOption | undefined {
  const host = handleHost(env)
  const webOrigin = publicOrigin()
  return host && webOrigin ? { handleHost: host, webOrigin } : webOrigin
}

/**
 * The `acct:` resource the WebFinger check asks for: the handle host when `FEDIVERSE_HANDLE_HOST`
 * is set (the CMS host stops resolving then), the host of the public origin otherwise.
 */
export function webFingerSubject(username: string, origin: string): string {
  return `acct:${username}@${handleHost() ?? new URL(origin).host}`
}
