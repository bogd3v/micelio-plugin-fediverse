/** Schemes a URL taken from a remote server may keep: anything else (`javascript:`, `data:`) is dropped. */
const SAFE_SCHEMES = new Set(['https:', 'http:'])

/**
 * A URL taken from a remote server (an actor's avatar), safe to store and to render as a link or an image.
 *
 * @remarks
 * Only an absolute `https:` or `http:` URL without credentials (`user:pass@`) is kept. A relative value
 * has no base to resolve against and is dropped, like any other scheme. The length is checked on the
 * normalised form, the one that is stored.
 *
 * @param value - The URL as the remote server sent it: a string or a parsed `URL`; anything else gives `null`.
 * @param maxLength - Longest URL kept, in characters: the size of the column it is stored in.
 * @returns The normalised URL (`URL.href`), or `null` when the value is not one to keep.
 */
export function safeRemoteUrl(value: unknown, maxLength: number): string | null {
  let url: URL
  if (value instanceof URL) {
    url = value
  } else if (typeof value === 'string') {
    try {
      url = new URL(value)
    } catch {
      return null
    }
  } else {
    return null
  }
  if (!SAFE_SCHEMES.has(url.protocol)) return null
  if (url.username || url.password) return null
  return url.href.length <= maxLength ? url.href : null
}
