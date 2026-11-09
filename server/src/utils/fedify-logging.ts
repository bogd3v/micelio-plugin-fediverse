import { AsyncLocalStorage } from 'node:async_hooks'

import type { Core } from '@strapi/strapi'
import { SendActivityError } from '@fedify/fedify'
import { configureSync, getConfig, resetSync, type LogRecord, type Sink } from '@logtape/logtape'

import { cleanRemoteText } from './remote-text'

type StrapiLog = Pick<Core.Strapi['log'], 'warn' | 'error'>

/** Longest message forwarded, in characters. */
const MAX_MESSAGE_LENGTH = 1000
/** Longest rendered value, in characters, before anything else reads it. */
const MAX_VALUE_LENGTH = 1000
/** Longest joined text, in characters, that cleaning and redaction work on. */
const MAX_WORKING_LENGTH = 2 * MAX_MESSAGE_LENGTH
/**
 * IPv4 literals, then IPv6 literals in brackets, with all eight groups or with
 * `::`. Every quantifier is bounded, so the work per record stays linear.
 */
const ADDRESS_PATTERNS: readonly RegExp[] = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\[(?=[0-9a-f.]{0,44}:)[0-9a-f:.]{2,45}\]/gi,
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi,
  /(?:\b[0-9a-f]{1,4})?(?::[0-9a-f]{1,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}\b)?/gi,
]
/** An absolute URL in a value, split into what is kept and its query string or fragment. */
const URL_QUERY = /\b(https?:\/\/[^\s?#]{1,1000})[?#]\S{0,1000}/gi
/** A message template is forwarded at most once per this interval; repeats are counted. */
const REPEAT_INTERVAL_MS = 60_000
/** Templates remembered for the repeat window before the memory is cleared. */
const MAX_TRACKED_TEMPLATES = 500
/** Shape of the `reason` property kept from a record: a camelCase code. */
const REASON_PATTERN = /^[A-Za-z]{1,40}$/
/** Category of Fedify's delivery records. */
const OUTBOX_CATEGORY = 'fedify.federation.outbox'
/** Marks the configuration this module installed, so it never resets someone else's. */
const OWN_CONFIG = Symbol('fediverse.logtape')

/** Strapi loggers that configured, oldest first; records go to the last one. */
const targets: StrapiLog[] = []
/** Last time each template was forwarded, and how many repeats were held back since. */
const recent = new Map<string, { at: number; suppressed: number; category: string }>()

/**
 * Routes Fedify's LogTape records of level `warning` and above to `strapi.log`,
 * once per process.
 *
 * @remarks
 * Fedify reports refused signatures, failed fetches and verification errors
 * only through LogTape, which writes nothing until it is configured. Calling
 * this again (another Strapi instance in the same module scope, as the test
 * suites do) only points the sink at the new logger. A LogTape configuration
 * installed by anyone else is left alone. Each record becomes one line: the
 * message is rendered from its template with every value cut to a fixed
 * length and URLs without their query string, then cleaned like remote text
 * and stripped of IP literals. Of the record's properties only a `reason` code
 * is kept (as `fedifyReason`), so request headers, activities and keys are
 * never written. A template repeats at most once a minute, and Fedify's
 * per-request access lines (`fedify.federation.http`, which carry the query
 * string) are dropped: `global::request-logger` already writes each request.
 * See `docs/security/logging.md`.
 */
export function configureFedifyLogging(log: StrapiLog): void {
  if (!targets.includes(log)) targets.push(log)
  const current = getConfig()
  if (current != null) {
    if (!isOwnConfig(current)) {
      log.warn('[fediverse] LogTape is already configured elsewhere; Fedify logs follow that setup')
    }
    return
  }
  const config = {
    sinks: { strapi: strapiSink },
    loggers: [
      { category: ['fedify'], sinks: ['strapi'], lowestLevel: 'warning' as const },
      { category: ['fedify', 'federation', 'http'], sinks: [], parentSinks: 'override' as const },
      // LogTape's own diagnostics; configuring it also silences its "configured" notice.
      { category: ['logtape', 'meta'], sinks: ['strapi'], lowestLevel: 'warning' as const },
    ],
    // Fedify runs its work inside LogTape contexts and warns on every request without one.
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
    [OWN_CONFIG]: true,
  }
  configureSync(config)
}

/**
 * Stops writing to `log`, the logger of a Strapi instance being destroyed.
 *
 * @remarks
 * Repeats still held back are written first. Records then go to the logger of
 * the previous instance that configured, if one is left; otherwise the
 * configuration is removed, which also drops LogTape's process exit hook.
 */
export function resetFedifyLogging(log: StrapiLog): void {
  const index = targets.indexOf(log)
  if (index === -1) return
  if (index === targets.length - 1) flushHeldBack(log)
  targets.splice(index, 1)
  if (targets.length > 0) return
  const current = getConfig()
  if (current != null && isOwnConfig(current)) resetSync()
}

function isOwnConfig(config: object): boolean {
  return (config as { [OWN_CONFIG]?: boolean })[OWN_CONFIG] === true
}

function flushHeldBack(log: StrapiLog): void {
  for (const { suppressed, category } of recent.values()) {
    if (suppressed > 0) log.warn(`[fediverse] ${category}: ${suppressed} similar lines held back`)
  }
  recent.clear()
}

const strapiSink: Sink = (record: LogRecord): void => {
  const log = targets[targets.length - 1]
  if (log == null) return
  if (record.level !== 'warning' && record.level !== 'error' && record.level !== 'fatal') return
  const category = record.category.join('.')
  const key = `${category} ${templateOf(record.rawMessage)}`
  const suppressed = repeatsHeldBack(key, category, Date.now())
  if (suppressed == null) return
  const repeats = suppressed > 0 ? ` (${suppressed} similar lines held back)` : ''
  const line = `[fediverse] ${category}: ${renderMessage(withoutRemoteBody(record))}${repeats}`
  const meta: Record<string, string> = { source: 'fedify', category }
  // Fedify's failure code (`keyFetchError`, `invalidSignature`, …): an identifier, never free text.
  const reason = record.properties.reason
  if (typeof reason === 'string' && REASON_PATTERN.test(reason)) meta.fedifyReason = reason
  if (record.level === 'warning') log.warn(line, meta)
  else log.error(line, meta)
}

/**
 * The record's message parts with a remote server's answer taken out. When an inbox
 * refuses a delivery, Fedify logs the response body, any text of any size, as a plain
 * string in the `{error}` slot of its outbox record.
 */
function withoutRemoteBody(record: LogRecord): readonly unknown[] {
  if (typeof record.rawMessage !== 'string' || record.category.join('.') !== OUTBOX_CATEGORY) {
    return record.message
  }
  const names = Array.from(record.rawMessage.matchAll(/\{([^{}]+)\}/g), (match) => match[1])
  const slot = names.indexOf('error')
  if (slot === -1 || typeof record.properties.error !== 'string') return record.message
  // Parts alternate between text and values, so the n-th placeholder is part 2n + 1.
  return record.message.map((part, index) =>
    index === 2 * slot + 1 ? '[response body omitted]' : part
  )
}

function templateOf(raw: string | TemplateStringsArray): string {
  return (typeof raw === 'string' ? raw : raw.join('{}')).slice(0, MAX_VALUE_LENGTH)
}

/** `null` when the template was forwarded within the interval; otherwise the repeats held back since. */
function repeatsHeldBack(key: string, category: string, now: number): number | null {
  const seen = recent.get(key)
  if (seen && now - seen.at < REPEAT_INTERVAL_MS) {
    seen.suppressed += 1
    return null
  }
  if (!seen && recent.size >= MAX_TRACKED_TEMPLATES) recent.clear()
  recent.set(key, { at: now, suppressed: 0, category })
  return seen?.suppressed ?? 0
}

/**
 * Joins a record's template parts into one bounded line: values are cut and
 * reduced to text first, then the whole is cut, cleaned (so invisible
 * characters cannot split an address) and redacted, then cut to its final length.
 */
function renderMessage(parts: readonly unknown[]): string {
  let text = parts
    .map((part, index) =>
      index % 2 === 0 ? String(part).slice(0, MAX_VALUE_LENGTH) : renderValue(part)
    )
    .join('')
    .slice(0, MAX_WORKING_LENGTH)
  text = cleanRemoteText(text, MAX_WORKING_LENGTH) ?? ''
  for (const pattern of ADDRESS_PATTERNS) text = text.replace(pattern, '[address]')
  text = Array.from(text).slice(0, MAX_MESSAGE_LENGTH).join('')
  return text === '' ? '(empty message)' : text
}

function renderValue(value: unknown): string {
  return withoutQuery(valueText(value).slice(0, MAX_VALUE_LENGTH))
}

function valueText(value: unknown): string {
  if (value == null) return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof URL) return value.href.split(/[?#]/, 1)[0] ?? ''
  // Its message ends with the remote server's answer to the delivery: untrusted text of any size.
  if (value instanceof SendActivityError) {
    return `SendActivityError: HTTP ${value.statusCode} from ${value.inbox.host}`
  }
  if (value instanceof Error) {
    return `${String(value.name).slice(0, 100)}: ${String(value.message).slice(0, MAX_VALUE_LENGTH)}`
  }
  // Objects (header maps, activities, keys) are not written.
  return '[object]'
}

/** Drops the query string and fragment of every absolute URL in `text`, keeping its path. */
function withoutQuery(text: string): string {
  return text.replace(URL_QUERY, '$1')
}
