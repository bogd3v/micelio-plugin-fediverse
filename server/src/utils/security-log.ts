import type { Core } from '@strapi/strapi'

type StrapiLog = Pick<Core.Strapi['log'], 'warn'>

/**
 * Why an inbox delivery was refused, from the app's `SECURITY_REASONS`:
 * `digest-algorithm` when its `Digest` header has no SHA-256 or SHA-512 entry,
 * `content-digest-not-covered` when an RFC 9421 signature skips
 * `content-digest`, `invalid-signature` for every `401` Fedify gives.
 */
export type InboxRefusalReason =
  'invalid-signature' | 'digest-algorithm' | 'content-digest-not-covered'

/**
 * Event name, message and field names of the app's `logSecurityEvent`
 * (`src/utils/security-log.ts`). The plugin is self-contained, so it keeps its
 * own copy; the two must stay identical because operators alert on them.
 */
const SIGNATURE_REFUSED_EVENT = 'fediverse.inbox.signature-refused'
/** Longest `path` written. */
const MAX_PATH_LENGTH = 200
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu
/**
 * Same redactions as the app copy: emails, IPv4, IPv6, then token-like runs
 * (16+ with a digit). Quantifiers are bounded by the path length, which is cut
 * before they run, so the work per path stays bounded.
 */
const PATH_REDACTIONS: readonly RegExp[] = [
  /[^\s/@]{1,200}@[^\s/@]{1,200}/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /(?:[0-9a-f]{0,4}:){2,7}[0-9a-f.]{0,45}/gi,
  /(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{16,200}/g,
]

/**
 * Writes the `fediverse.inbox.signature-refused` security event: a `warn` line
 * `security: fediverse.inbox.signature-refused` with `event`, `outcome`
 * (`failure`), `path` and `reason` as metadata.
 *
 * @remarks
 * Takes only the request path: no address, header, key id or signature is
 * written. The path loses its query string and is redacted like the app's
 * security log. See `docs/security/logging.md`.
 *
 * @param path - The request path as received; the query string is dropped here.
 */
export function logInboxSignatureRefused(
  log: StrapiLog,
  path: string,
  reason: InboxRefusalReason
): void {
  const meta: Record<string, string> = {
    event: SIGNATURE_REFUSED_EVENT,
    outcome: 'failure',
  }
  const cleanPath = sanitizePath(path)
  if (cleanPath) meta.path = cleanPath
  meta.reason = reason
  log.warn(`security: ${SIGNATURE_REFUSED_EVENT}`, meta)
}

function sanitizePath(value: string): string | undefined {
  // Three characters per decoded one at most (`%XX`), so the cut keeps every escape it needs.
  let text = (value.split(/[?#]/, 1)[0] ?? '').slice(0, 3 * MAX_PATH_LENGTH)
  try {
    text = decodeURIComponent(text)
  } catch {
    // Malformed escapes (or one cut in half) stay as they are; the redactions below still apply.
  }
  text = text.replace(CONTROL_CHARACTERS, ' ').slice(0, MAX_PATH_LENGTH)
  for (const pattern of PATH_REDACTIONS) text = text.replace(pattern, '[redacted]')
  text = text.trim().slice(0, MAX_PATH_LENGTH)
  return text === '' ? undefined : text
}
