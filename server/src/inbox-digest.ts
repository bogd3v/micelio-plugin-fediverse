/**
 * The `Digest` header check of inbox deliveries (ASVS V11.4.1, V11.4.3).
 *
 * Fedify 2.4.2 verifies a draft-cavage `Digest` header with SHA-1 (`SHA=`) as
 * readily as with SHA-256 and has no option to turn SHA-1 off, so the inbox
 * middleware runs this check before handing the request to Fedify. See
 * `docs/FEDIVERSE.md`, "Inbox digest algorithms".
 */

import type { IncomingHttpHeaders } from 'node:http'
import { isContentDigestCovered } from './inbox-signature-input'
import type { InboxRefusalReason } from './utils/security-log'

/** Why the inbox middleware answers `401` to a delivery before Fedify reads it. */
export interface InboxDigestRefusal {
  /** The `reason` of the `fediverse.inbox.signature-refused` security event. */
  reason: Extract<InboxRefusalReason, 'digest-algorithm' | 'content-digest-not-covered'>
  /** The `text/plain` response body. */
  message: string
  /** The rate-limited `[fediverse]` warning, with no header value in it. */
  warning: string
}

/** One `algorithm=value` entry of a `Digest` header (RFC 3230). */
export interface DigestEntry {
  /** The algorithm name, lower case (`sha-256`). */
  algorithm: string
  /** The encoded digest as sent, trimmed; empty when the entry has none. */
  value: string
}

/** Algorithms an inbox delivery's `Digest` may use, lower case. */
const APPROVED_ALGORITHMS: ReadonlySet<string> = new Set(['sha-256', 'sha-512'])

/**
 * Splits a `Digest` header into its entries.
 *
 * @remarks
 * Entries are separated by commas; each splits at its first `=`, so base64
 * padding stays in the value. Empty entries (`a=1,,b=2`) are skipped.
 *
 * @internal
 */
export function parseDigestHeader(header: string): DigestEntry[] {
  const entries: DigestEntry[] = []
  for (const part of header.split(',')) {
    const entry = part.trim()
    if (entry === '') continue
    const separator = entry.indexOf('=')
    entries.push(
      separator < 0
        ? { algorithm: entry.toLowerCase(), value: '' }
        : {
            algorithm: entry.slice(0, separator).trim().toLowerCase(),
            value: entry.slice(separator + 1).trim(),
          }
    )
  }
  return entries
}

/**
 * Whether an inbox delivery's `Digest` header names an approved algorithm: at
 * least one SHA-256 or SHA-512 entry with a value.
 *
 * @remarks
 * Other entries next to an approved one (`SHA=…`, unknown algorithms) are
 * allowed: Fedify requires every entry it knows to match the body, so a SHA-1
 * entry can only add a check, never replace the SHA-256 or SHA-512 one. An
 * empty header, or one with only other algorithms (SHA-1, MD5), is refused.
 * Checks the algorithms only: whether the digest matches the body, and whether
 * the header is signed, is left to Fedify's signature verification.
 */
export function isInboxDigestAccepted(header: string): boolean {
  return parseDigestHeader(header).some(
    (entry) => APPROVED_ALGORITHMS.has(entry.algorithm) && entry.value !== ''
  )
}

/**
 * Why an inbox `POST` must be refused before Fedify reads it, or `null` to hand
 * it to Fedify.
 *
 * @remarks
 * An RFC 9421 delivery (any `Signature-Input` header, which is how Fedify
 * picks RFC 9421) is refused unless every signature covers `content-digest`
 * (`inbox-signature-input.ts`). A `Digest` header is refused unless it has a
 * SHA-256 or SHA-512 entry. Without either header, Fedify decides alone.
 * Repeated headers are joined with `, `, as Fedify's `Headers.get` does.
 */
export function inboxDigestRefusal(headers: IncomingHttpHeaders): InboxDigestRefusal | null {
  const signatureInput = joinHeader(headers['signature-input'])
  if (signatureInput !== undefined && !isContentDigestCovered(signatureInput)) {
    return {
      reason: 'content-digest-not-covered',
      message: 'The signature must cover the Content-Digest header.',
      warning:
        '[fediverse] refused an RFC 9421 inbox delivery whose signature skips content-digest',
    }
  }
  const digest = joinHeader(headers.digest)
  if (digest !== undefined && !isInboxDigestAccepted(digest)) {
    return {
      reason: 'digest-algorithm',
      message: 'The Digest header must use SHA-256 or SHA-512.',
      warning: '[fediverse] refused an inbox delivery whose Digest has no SHA-256 or SHA-512 entry',
    }
  }
  return null
}

function joinHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}
