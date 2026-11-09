import { isIPv4, isIPv6 } from 'node:net'

import { SendActivityError } from '@fedify/fedify'

import { cleanRemoteText } from './remote-text'

const MAX_ERROR_LENGTH = 500
/** Sub-errors of an `AggregateError` worth keeping: one per failed inbox is more than a row needs. */
const MAX_SUB_ERRORS = 3

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi
const EMAIL_PATTERN = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
/** Anything made of hex digits, dots and colons with a colon in it; `net.isIPv6` decides. */
const IPV6_CANDIDATE = /\[?[0-9a-f:.]*:[0-9a-f:.]*\]?/gi

function messagesOf(error: unknown): string[] {
  if (typeof error === 'string') return [error]
  if (!(error instanceof Error)) return []
  // Its message ends with the remote server's answer, which is untrusted text.
  if (error instanceof SendActivityError) {
    return [`The inbox at ${error.inbox.host} answered HTTP ${error.statusCode}`]
  }
  // An `AggregateError` (one failure per inbox) carries its causes in `errors`.
  const causes = (error as { errors?: unknown }).errors
  const nested = Array.isArray(causes) ? causes.slice(0, MAX_SUB_ERRORS).flatMap(messagesOf) : []
  return [error.message, ...nested]
}

/**
 * The reason a delivery failed, safe to store on the federated article row.
 *
 * @remarks
 * Query strings and fragments are cut from every URL, IP literals and email
 * addresses are replaced, and the text goes through `cleanRemoteText`: a
 * remote server's answer or a follower's inbox address must not end up in the
 * database, where an admin panel will show it. A `SendActivityError` is reduced
 * to the inbox's host and the HTTP status: its message carries the response body.
 *
 * @returns The cleaned text, at most 500 characters, or `null` when nothing is left.
 */
export function describeDeliveryError(error: unknown): string | null {
  const text = messagesOf(error)
    .filter(Boolean)
    .join(' | ')
    .replace(URL_PATTERN, (url) => url.replace(/[?#].*$/, ''))
    .replace(EMAIL_PATTERN, '[email]')
    .replace(IPV4_PATTERN, (match) => (isIPv4(match) ? '[ip]' : match))
    .replace(IPV6_CANDIDATE, (match) => (isIPv6(match.replace(/^\[|\]$/g, '')) ? '[ip]' : match))
  return cleanRemoteText(text, MAX_ERROR_LENGTH)
}
