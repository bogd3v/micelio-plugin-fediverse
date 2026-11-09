import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { getLogger } from '@logtape/logtape'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'

const ACTIVITY_JSON = 'application/activity+json'
const INBOX = '/fediverse/user/devbog/inbox'
const SECURITY_MESSAGE = 'security: fediverse.inbox.signature-refused'
/** More than the plugin's one-minute repeat window, so each test starts with a fresh one. */
const WINDOW_STEP_MS = 61_000

type LogCall = { level: 'warn' | 'error' | 'info'; message: string; meta: unknown }

describe('Fediverse logging (Fedify LogTape records and refused inbox signatures)', () => {
  let host: string
  let remote: RemoteActor
  let calls: LogCall[] = []
  let spies: Array<{ mockRestore(): void }> = []
  let clockOffset = 0
  const realNow = Date.now.bind(Date)

  const followFrom = (actor: string, id: string) => ({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id,
    type: 'Follow',
    actor,
    object: `http://${host}/fediverse/user/devbog`,
  })
  const securityLines = () => calls.filter((call) => call.message === SECURITY_MESSAGE)
  const serialized = () => calls.map((call) => `${call.message} ${JSON.stringify(call.meta)}`)

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    await setupStrapi()
    host = serverHost()
    remote = await createRemoteActor({ preferredUsername: 'logger-test' })
  })

  afterAll(async () => {
    await remote?.close()
    await cleanupStrapi()
  })

  beforeEach(() => {
    calls = []
    // Only Date.now moves (signatures use new Date()), so no test sees a repeat window left by another.
    clockOffset += WINDOW_STEP_MS
    spies = (['warn', 'error', 'info'] as const).map((level) =>
      vi.spyOn(strapi.log, level).mockImplementation(((message: unknown, meta?: unknown) => {
        calls.push({ level, message: String(message), meta })
        return strapi.log
      }) as never)
    )
    spies.push(vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset))
  })

  afterEach(() => {
    for (const spy of spies) spy.mockRestore()
  })

  it('logs an unsigned inbox POST as a refused signature and answers as before', async () => {
    const res = await request(strapi.server.httpServer)
      .post(`${INBOX}?token=abcdef0123456789abcdef`)
      .set('Content-Type', ACTIVITY_JSON)
      .send(followFrom('https://remote.example.test/users/a', 'https://remote.example.test/f/1'))

    expect(res.status).toBe(401)
    expect(res.text).toBe('Failed to verify the request signature.')
    expect(securityLines()).toEqual([
      {
        level: 'warn',
        message: SECURITY_MESSAGE,
        meta: {
          event: 'fediverse.inbox.signature-refused',
          outcome: 'failure',
          path: INBOX,
          reason: 'invalid-signature',
        },
      },
    ])
    // Fedify's own record of the refusal reaches strapi.log too.
    expect(calls).toContainEqual({
      level: 'error',
      message:
        "[fediverse] fedify.federation.inbox: Failed to verify the request's HTTP Signatures.",
      meta: { source: 'fedify', category: 'fedify.federation.inbox', fedifyReason: 'noSignature' },
    })
    // Fedify's access line (with the query string) is dropped; request-logger writes requests.
    expect(serialized().join('\n')).not.toContain('abcdef0123456789')
    expect(calls.some((call) => call.message.includes('fedify.federation.http'))).toBe(false)
  })

  it('writes the event with its name, outcome and reason', async () => {
    await request(strapi.server.httpServer)
      .post(INBOX)
      .set('Content-Type', ACTIVITY_JSON)
      .send(followFrom('https://remote.example.test/users/c', 'https://remote.example.test/f/3'))
      .expect(401)

    const [line] = securityLines()
    const meta = line?.meta as { event: string; outcome: string; reason: string }
    expect(meta.event).toBe('fediverse.inbox.signature-refused')
    expect(line?.message).toBe('security: fediverse.inbox.signature-refused')
    expect(meta.outcome).toBe('failure')
    expect(meta.reason).toBe('invalid-signature')
  })

  it('logs every refusal, on the shared inbox too, while repeats of the Fedify line are held back', async () => {
    const paths = ['/fediverse/inbox', INBOX, INBOX]
    for (const path of paths) {
      await request(strapi.server.httpServer)
        .post(path)
        .set('Content-Type', ACTIVITY_JSON)
        .send(followFrom('https://remote.example.test/users/b', 'https://remote.example.test/f/2'))
        .expect(401)
    }

    expect(securityLines().map((call) => (call.meta as { path: string }).path)).toEqual(paths)
    expect(calls.filter((call) => call.message.includes('HTTP Signatures'))).toHaveLength(1)
  })

  it('does not log a refusal for federation reads', async () => {
    await request(strapi.server.httpServer)
      .get('/fediverse/user/devbog')
      .set('Accept', ACTIVITY_JSON)
      .expect(200)
    expect(securityLines()).toEqual([])
  })

  it('writes no signature, key or client address for a tampered signed delivery', async () => {
    const activity = followFrom(remote.actorUrl, `${remote.actorUrl}/follows/tampered`)
    const signed = await remote.signActivity(`http://${host}${INBOX}`, activity)
    // Same signed headers, different body: the digest no longer matches.
    const tampered = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify({ ...activity, id: `${remote.actorUrl}/follows/other` }),
    })
    const signature = signed.headers.get('signature') ?? ''
    expect(signature).not.toBe('')

    const res = await fetch(tampered)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Failed to verify the request signature.')

    await waitUntil(() => securityLines().length === 1)
    const text = serialized().join('\n')
    const signatureValue = /signature="([^"]+)"/.exec(signature)?.[1] ?? signature
    expect(text).not.toContain(signatureValue)
    expect(text).not.toContain('#main-key')
    expect(text).not.toMatch(/BEGIN [A-Z ]*KEY/)
    expect(text).not.toMatch(/\b127\.0\.0\.1\b/)
    expect(text).not.toContain('::1')
  })

  it('forwards a template once a minute and counts the repeats it held back', () => {
    const logger = getLogger(['fedify', 'federation', 'test'])
    logger.warn('a repeated warning {n}', { n: 1 })
    logger.warn('a repeated warning {n}', { n: 2 })
    logger.warn('another warning')

    expect(calls.map((call) => call.message)).toEqual([
      '[fediverse] fedify.federation.test: a repeated warning 1',
      '[fediverse] fedify.federation.test: another warning',
    ])
  })

  it('forwards Fedify warnings, not its info or debug records', () => {
    const logger = getLogger(['fedify', 'federation', 'test'])
    logger.debug('a debug record')
    logger.info('an info record')
    logger.warn('a warning about {url}', {
      url: new URL('https://remote.example.test/a?token=abcdef0123456789#frag'),
    })

    expect(calls).toEqual([
      {
        level: 'warn',
        message:
          '[fediverse] fedify.federation.test: a warning about https://remote.example.test/a',
        meta: { source: 'fedify', category: 'fedify.federation.test' },
      },
    ])
  })

  it('cannot be made to forge a second line, leak an object or an address through remote text', () => {
    getLogger(['fedify', 'federation', 'test']).error(
      'Remote said {value} with {headers} from {address}',
      {
        value: 'hi\n2026-10-16 10:00:00.000 info: forged\u2028line',
        headers: { signature: 'keyId="x",signature="c2VjcmV0"' },
        address: '203.0.113.7',
      }
    )

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.level).toBe('error')
    expect(call.message).not.toMatch(/[\n\r\u2028\u2029]/)
    expect(call.message).toBe(
      '[fediverse] fedify.federation.test: Remote said hi 2026-10-16 10:00:00.000 info: forged line with [object] from [address]'
    )
  })
})
