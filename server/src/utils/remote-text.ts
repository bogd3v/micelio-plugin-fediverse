/** Line breaks and other control characters, and the invisible format characters (zero width, bidi overrides). */
const CONTROL = /[\p{Cc}\u2028\u2029]/gu
const INVISIBLE = /\p{Cf}/gu

/**
 * A name or handle taken from a remote server, safe to log and to store.
 *
 * @remarks
 * Control characters become a space (so a line break cannot start a forged log
 * line), invisible format characters are dropped, runs of whitespace collapse
 * and the result is cut to `maxLength` characters.
 *
 * @returns The cleaned text, or `null` when nothing is left.
 */
export function cleanRemoteText(value: unknown, maxLength = 255): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  return text ? Array.from(text).slice(0, maxLength).join('') : null
}
