/**
 * The CMS's public origin (`URL`) when the operator has set it, for Fedify to
 * build every actor, inbox and key id from instead of the request.
 *
 * @remarks
 * Without it Fedify takes the scheme and host from the request, which with
 * `TRUST_PROXY_PROTOCOL` means `X-Forwarded-Host` and `-Proto`, honoured only
 * from the peers `TRUST_PROXY` trusts. A proxy it does not list can then have
 * the actor document name its own host, and a cache may store it. Unset (local
 * development, tests) keeps the request-derived origin.
 *
 * @returns The origin, without path, or `undefined` when `URL` is unset or not an absolute URL.
 */
export function publicOrigin(): string | undefined {
  const value = process.env.URL?.trim()
  if (!value) return undefined
  try {
    const { origin } = new URL(value)
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}
