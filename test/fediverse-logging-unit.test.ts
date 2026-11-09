import path from 'path'
import { describe, it, expect, afterEach } from 'vitest'
import { getLogger } from '@logtape/logtape'
import { configureFedifyLogging, resetFedifyLogging } from '../server/src/utils/fedify-logging'
import { logInboxSignatureRefused } from '../server/src/utils/security-log'

/** Generous bound for one record; the bounded rendering takes well under a millisecond. */
const MAX_MS_PER_CALL = 100
const PREFIX = '[fediverse] fedify.unit: '

type Line = { level: 'warn' | 'error'; message: string; meta?: unknown }

function fakeLog() {
  const lines: Line[] = []
  return {
    lines,
    warn: (message: string, meta?: unknown) => void lines.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: unknown) => void lines.push({ level: 'error', message, meta }),
  }
}

describe('Fedify log forwarding without Strapi', () => {
  const configured: Array<ReturnType<typeof fakeLog>> = []
  const logger = getLogger(['fedify', 'unit'])

  function configure() {
    const log = fakeLog()
    configured.push(log)
    configureFedifyLogging(log as never)
    return log
  }

  afterEach(() => {
    while (configured.length > 0) resetFedifyLogging(configured.pop() as never)
  })

  it('resolves the same LogTape copy as Fedify', () => {
    const fedifyDir = path.dirname(require.resolve('@fedify/fedify'))
    expect(require.resolve('@logtape/logtape', { paths: [fedifyDir] })).toBe(
      require.resolve('@logtape/logtape')
    )
  })

  it("leaves a refusing inbox's response body out of Fedify's delivery record", () => {
    const log = configure()
    getLogger(['fedify', 'federation', 'outbox']).error(
      'Failed to send activity {activityId} to {inbox} ({status} {statusText}):\n{error}',
      {
        activityId: 'https://blog.example.test/fediverse/articles/a1#create',
        inbox: 'https://remote.example.test/inbox',
        status: 500,
        statusText: 'Internal Server Error',
        error: 'REMOTE-BODY-MUST-NOT-LEAK',
      }
    )

    expect(log.lines).toHaveLength(1)
    expect(log.lines[0].message).toContain('(500 Internal Server Error)')
    expect(log.lines[0].message).toContain('[response body omitted]')
    expect(log.lines[0].message).not.toContain('REMOTE-BODY-MUST-NOT-LEAK')
  })

  it('bounds the work per record and caps a 100,000-character value', () => {
    const log = configure()
    const values = [
      'a'.repeat(100_000),
      ':0'.repeat(50_000),
      `[${':'.repeat(99_998)}]`,
      '1.'.repeat(50_000),
      `https://remote.example.test/${'x'.repeat(100_000)}?q=1`,
      '\u200b'.repeat(100_000),
    ]
    values.forEach((value, index) => {
      const started = performance.now()
      logger.warn(`value ${index} {value}`, { value })
      expect(performance.now() - started).toBeLessThan(MAX_MS_PER_CALL)
    })

    expect(log.lines).toHaveLength(values.length)
    for (const line of log.lines) {
      expect(Array.from(line.message).length).toBeLessThanOrEqual(PREFIX.length + 1000)
    }
  })

  it('redacts an address split by invisible characters and drops URL query strings', () => {
    const log = configure()
    logger.error('fetch of {url} from {address} failed: {error}', {
      url: new URL('https://remote.example.test/users/a?token=abcdef0123456789#main'),
      address: '203.0\u200b.113.7',
      error: new Error('HTTP 404: https://remote.example.test/inbox?sig=c2VjcmV0'),
    })

    expect(log.lines.map((line) => line.message)).toEqual([
      `${PREFIX}fetch of https://remote.example.test/users/a from [address] failed: Error: HTTP 404: https://remote.example.test/inbox`,
    ])
  })

  it('writes the repeats still held back when the logger is reset', () => {
    const log = fakeLog()
    configureFedifyLogging(log as never)
    logger.warn('held {n}', { n: 1 })
    logger.warn('held {n}', { n: 2 })
    logger.warn('held {n}', { n: 3 })
    resetFedifyLogging(log as never)

    expect(log.lines.map((line) => line.message)).toEqual([
      `${PREFIX}held 1`,
      '[fediverse] fedify.unit: 2 similar lines held back',
    ])
  })

  it('falls back to the previous logger when the newest one is reset', () => {
    const first = configure()
    const second = configure()
    logger.warn('to the second')
    resetFedifyLogging(second as never)
    configured.splice(configured.indexOf(second), 1)
    logger.warn('to the first')

    expect(second.lines.map((line) => line.message)).toEqual([`${PREFIX}to the second`])
    expect(first.lines.map((line) => line.message)).toEqual([`${PREFIX}to the first`])
  })
})

describe('logInboxSignatureRefused', () => {
  it('cuts and redacts a long path within a bounded time', () => {
    const log = fakeLog()
    const longPath = `/fediverse/user/${'a'.repeat(50_000)}${'b@'.repeat(25_000)}/inbox?x=1`
    const started = performance.now()
    logInboxSignatureRefused(log as never, longPath, 'invalid-signature')
    expect(performance.now() - started).toBeLessThan(MAX_MS_PER_CALL)

    const meta = log.lines[0]?.meta as { path: string }
    expect(meta.path.length).toBeLessThanOrEqual(200)
    expect(meta.path).not.toContain('?')
  })
})
