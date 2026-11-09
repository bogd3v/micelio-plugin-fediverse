import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { generateCryptoKeyPair, verifyRequest } from '@fedify/fedify'
import type { webcrypto } from 'node:crypto'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { decryptText, encryptText, isEncryptedEnvelope } from '../server/src/utils/key-encryption'

const ACTIVITY_JSON = 'application/activity+json'
/** Neutral actor handle and URI path, set before Strapi boots so WebFinger and the actor URL agree. */
const ACTOR_USERNAME = 'alice'
const ACTOR_IDENTIFIER = 'actor'
const CORE_STORE_KEY = 'plugin_fediverse_keyPairs'
const OTHER_KEY = 'fedcba9876543210fedcba9876543210'
/** The plugin repeats a key pairs failure line at most once a minute (`WARNING_INTERVAL_MS`). */
const LOG_INTERVAL_MS = 60_000
const DECRYPTION_LINE = 'cannot decrypt the actor private key'
/** The body of every key failure: the cause is only in the server log. */
const GENERIC_BODY = 'Internal Server Error'

interface ActorDocument {
  id: string
  publicKey?: { publicKeyPem?: string }
}

type Jwk = Record<string, unknown>

interface StoredEntry {
  name: string
  publicJwk: Jwk
  privateJwk: Jwk
}

/** The parts of the plugin's `keys` service these tests call. */
interface KeysService {
  encryptStoredActorKeys(strapi: unknown): Promise<void>
  getActorKeyPairs(
    strapi: unknown
  ): Promise<{ publicKey: webcrypto.CryptoKey; privateKey: webcrypto.CryptoKey }[]>
}

/** The core store row exactly as the database holds it. */
async function rawRow(): Promise<{ id: number; value: string } | null> {
  return strapi.db.query('strapi::core-store').findOne({ where: { key: CORE_STORE_KEY } })
}

async function storedEntries(): Promise<StoredEntry[]> {
  const row = await rawRow()
  if (!row) throw new Error('no stored key pair')
  return JSON.parse(row.value) as StoredEntry[]
}

async function writeEntries(value: unknown): Promise<void> {
  await strapi.store({ type: 'plugin', name: 'fediverse' }).set({ key: 'keyPairs', value })
}

async function deleteEntries(): Promise<void> {
  await strapi.db.query('strapi::core-store').delete({ where: { key: CORE_STORE_KEY } })
}

/**
 * Moves `Date.now` forward by `ms` from the real clock, so the plugin's log
 * throttle sees a new interval without a real wait; restored by the caller.
 */
function shiftClock(ms: number): MockInstance<typeof Date.now> {
  const realNow = Date.now.bind(Date)
  return vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms)
}

/** WebFinger for the actor's handle on the test server's own host, which Fedify requires. */
function webfingerUrl(): string {
  const resource = encodeURIComponent(`acct:${ACTOR_USERNAME}@${serverHost()}`)
  return `http://${serverHost()}/.well-known/webfinger?resource=${resource}`
}

/** Asserts a fail-closed answer: `500` with the generic body, nothing about the key. */
async function expectGenericFailure(res: Response): Promise<void> {
  expect(res.status).toBe(500)
  expect(await res.text()).toBe(GENERIC_BODY)
}

describe('AES-256-GCM envelope of the actor key', () => {
  const jwk: Jwk = { kty: 'RSA', n: 'bW9kdWx1cw', e: 'AQAB', d: 'c2VjcmV0' }
  const secret = JSON.stringify(jwk)
  const key = '0123456789abcdef0123456789abcdef'

  it('round-trips a JWK and never writes it in clear', () => {
    const envelope = encryptText(secret, key)
    expect(isEncryptedEnvelope(envelope)).toBe(true)
    expect(JSON.stringify(envelope)).not.toContain('c2VjcmV0')
    expect(decryptText(envelope, key)).toBe(secret)
  })

  it('uses a fresh IV for every encryption', () => {
    expect(encryptText(secret, key).iv).not.toBe(encryptText(secret, key).iv)
  })

  it('tells a plain JWK from an envelope', () => {
    expect(isEncryptedEnvelope(jwk)).toBe(false)
    expect(isEncryptedEnvelope({ ...jwk, alg: 'RS256' })).toBe(false)
  })

  it.each([
    ['a wrong key', OTHER_KEY],
    ['no key', null],
  ])('refuses %s, naming ENCRYPTION_KEY', (_label, wrong) => {
    expect(() => decryptText(encryptText(secret, key), wrong)).toThrow(/ENCRYPTION_KEY/)
  })

  it.each(['data', 'tag', 'iv'] as const)('refuses an altered %s', (field) => {
    const envelope = encryptText(secret, key)
    const bytes = Buffer.from(envelope[field], 'base64url')
    bytes[0] ^= 1
    expect(() => decryptText({ ...envelope, [field]: bytes.toString('base64url') }, key)).toThrow(
      /ENCRYPTION_KEY/
    )
  })

  it('refuses a truncated tag', () => {
    const envelope = encryptText(secret, key)
    const tag = Buffer.from(envelope.tag, 'base64url').subarray(0, 4).toString('base64url')
    expect(() => decryptText({ ...envelope, tag }, key)).toThrow(/ENCRYPTION_KEY/)
  })
})

describe('Fediverse actor key encrypted at rest', () => {
  let actorUrl: string
  let keysService: KeysService
  let encryptionKey: string

  async function actorDocument(): Promise<ActorDocument> {
    const res = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
    expect(res.status).toBe(200)
    return (await res.json()) as ActorDocument
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = ACTOR_IDENTIFIER
    process.env.FRONTEND_URL = 'https://blog.example.test'
    await setupStrapi()
    await setFediverseUsername(ACTOR_USERNAME)

    actorUrl = `http://${serverHost()}/fediverse/user/${ACTOR_IDENTIFIER}`
    keysService = strapi.plugin('fediverse').service('keys')
    encryptionKey = strapi.config.get('admin.secrets.encryptionKey') as string
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  afterEach(() => {
    strapi.config.set('admin.secrets.encryptionKey', encryptionKey)
  })

  it('stores a fresh private key encrypted and the public key plain', async () => {
    await deleteEntries()
    await actorDocument()

    const row = await rawRow()
    expect(row?.value).not.toMatch(/"d":/)
    const [entry] = await storedEntries()
    expect(isEncryptedEnvelope(entry.privateJwk)).toBe(true)
    expect(entry.privateJwk).not.toHaveProperty('d')
    expect(entry.publicJwk).toHaveProperty('n')
  })

  it('serves the actor and signs an Accept that verifies with the published key', async () => {
    const before = await actorDocument()
    expect(before.publicKey?.publicKeyPem).toBeTruthy()

    const remote = await createRemoteActor({ preferredUsername: 'key-checker' })
    try {
      const res = await remote.postSignedActivity(`${actorUrl}/inbox`, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${remote.actorUrl}/follows/1`,
        type: 'Follow',
        actor: remote.actorUrl,
        object: actorUrl,
      })
      expect(res.ok).toBe(true)

      await waitUntil(() => remote.inboxDeliveries.find((activity) => activity.type === 'Accept'))
      const delivery = remote.inboxRequests.find(({ body }) => body.includes('"Accept"'))
      if (!delivery) throw new Error('no Accept delivery recorded')

      const request = new Request(remote.inboxUrl, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body,
      })
      const key = await verifyRequest(request, {
        spec: delivery.headers.has('signature-input')
          ? 'rfc9421'
          : 'draft-cavage-http-signatures-12',
        documentLoader: async (url: string) => {
          const fetched = await fetch(url, { headers: { accept: ACTIVITY_JSON } })
          return { contextUrl: null, documentUrl: url, document: await fetched.json() }
        },
      })
      expect(key?.ownerId?.href).toBe(actorUrl)
    } finally {
      await remote.close()
    }
  })

  it('encrypts a plain legacy entry without changing the actor identity', async () => {
    const legacy = await generateCryptoKeyPair()
    const publicJwk = await crypto.subtle.exportKey('jwk', legacy.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', legacy.privateKey)
    await writeEntries([
      { name: 'main-key', publicJwk, privateJwk, algorithm: 'RSASSA-PKCS1-v1_5', generatedAt: '' },
    ])
    expect((await rawRow())?.value).toMatch(/"d":/)

    await keysService.encryptStoredActorKeys(strapi)

    const [entry] = await storedEntries()
    expect(isEncryptedEnvelope(entry.privateJwk)).toBe(true)
    expect((await rawRow())?.value).not.toMatch(/"d":/)
    expect(entry.publicJwk).toEqual(publicJwk)

    const [pair] = await keysService.getActorKeyPairs(strapi)
    expect((await crypto.subtle.exportKey('jwk', pair.privateKey)).d).toBe(privateJwk.d)

    const document = await actorDocument()
    expect(document.id).toBe(actorUrl)
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', legacy.publicKey))
    const pemBody = (document.publicKey?.publicKeyPem ?? '').replace(/-----[^-]+-----|\s/g, '')
    expect(pemBody).toBe(spki.toString('base64'))
  })

  it('encrypts a plain entry at first use as well, and only once', async () => {
    const legacy = await generateCryptoKeyPair()
    await writeEntries([
      {
        name: 'main-key',
        publicJwk: await crypto.subtle.exportKey('jwk', legacy.publicKey),
        privateJwk: await crypto.subtle.exportKey('jwk', legacy.privateKey),
        algorithm: 'RSASSA-PKCS1-v1_5',
        generatedAt: '',
      },
    ])

    await actorDocument()
    const sealed = await rawRow()
    expect(sealed?.value).not.toMatch(/"d":/)

    await actorDocument()
    await keysService.encryptStoredActorKeys(strapi)
    expect(await rawRow()).toEqual(sealed)
  })

  it('refuses a wrong ENCRYPTION_KEY and leaves the stored entry byte-identical', async () => {
    await actorDocument()
    const before = await rawRow()

    strapi.config.set('admin.secrets.encryptionKey', OTHER_KEY)
    await expect(keysService.getActorKeyPairs(strapi)).rejects.toThrow(/ENCRYPTION_KEY/)
    await keysService.encryptStoredActorKeys(strapi)
    await expectGenericFailure(await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } }))

    expect(await rawRow()).toEqual(before)
  })

  it('fails closed with a generic 500 on the actor, WebFinger and an inbox, logging the cause once', async () => {
    await actorDocument()
    const before = await rawRow()
    const remote = await createRemoteActor({ preferredUsername: 'locked-out' })
    // A minute past the previous test's failure, so its log line does not hold this one back.
    const clock = shiftClock(LOG_INTERVAL_MS + 1_000)
    const logError = vi.spyOn(strapi.log, 'error')
    // Koa prints every error that escapes the middleware with its stack.
    const consoleError = vi.spyOn(console, 'error')

    try {
      // With the right key the same WebFinger request answers, so the 500 below is the key's.
      expect((await fetch(webfingerUrl())).status).toBe(200)
      strapi.config.set('admin.secrets.encryptionKey', OTHER_KEY)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expectGenericFailure(await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } }))
        await expectGenericFailure(await fetch(webfingerUrl()))
      }

      // No queue: the inbox runs the Follow listener, and its Accept, before it answers.
      const inbox = await remote.postSignedActivity(`${actorUrl}/inbox`, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${remote.actorUrl}/follows/locked`,
        type: 'Follow',
        actor: remote.actorUrl,
        object: actorUrl,
      })
      await expectGenericFailure(inbox)
      expect(remote.inboxRequests).toHaveLength(0)

      const decryptionLines = logError.mock.calls.filter(([message]) =>
        String(message).includes(DECRYPTION_LINE)
      )
      expect(decryptionLines).toHaveLength(1)
      for (const [message, ...rest] of logError.mock.calls) {
        expect(String(message)).not.toMatch(/"d":|privateJwk|\n\s+at /)
        expect(rest).toHaveLength(0)
      }
      expect(consoleError).not.toHaveBeenCalled()
      expect(await rawRow()).toEqual(before)
    } finally {
      clock.mockRestore()
      consoleError.mockRestore()
      logError.mockRestore()
      await remote.close()
    }
  })

  it('logs a persisting key failure again once the interval has passed', async () => {
    strapi.config.set('admin.secrets.encryptionKey', OTHER_KEY)
    const logError = vi.spyOn(strapi.log, 'error')
    const decryptionLines = (): number =>
      logError.mock.calls.filter(([message]) => String(message).includes(DECRYPTION_LINE)).length
    // Past the line logged by the previous test (shifted by one interval).
    let clock = shiftClock(2 * LOG_INTERVAL_MS + 2_000)

    try {
      await expectGenericFailure(await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } }))
      await expectGenericFailure(await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } }))
      expect(decryptionLines()).toBe(1)

      clock.mockRestore()
      clock = shiftClock(3 * LOG_INTERVAL_MS + 3_000)
      await expectGenericFailure(await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } }))
      expect(decryptionLines()).toBe(2)
    } finally {
      clock.mockRestore()
      logError.mockRestore()
    }
  })

  it('refuses a missing ENCRYPTION_KEY once the key is encrypted', async () => {
    await actorDocument()
    const before = await rawRow()

    strapi.config.set('admin.secrets.encryptionKey', undefined)
    await expect(keysService.getActorKeyPairs(strapi)).rejects.toThrow(/ENCRYPTION_KEY/)

    expect(await rawRow()).toEqual(before)
  })

  it('refuses tampered ciphertext and leaves it as stored', async () => {
    await actorDocument()
    const [entry] = await storedEntries()
    const data = Buffer.from(String(entry.privateJwk.data), 'base64url')
    data[data.length - 1] ^= 1
    await writeEntries([
      { ...entry, privateJwk: { ...entry.privateJwk, data: data.toString('base64url') } },
    ])
    const before = await rawRow()

    await expect(keysService.getActorKeyPairs(strapi)).rejects.toThrow(/ENCRYPTION_KEY/)

    expect(await rawRow()).toEqual(before)
    await deleteEntries()
  })

  it('keeps a plain key without ENCRYPTION_KEY and encrypts it once the key is set', async () => {
    await deleteEntries()
    strapi.config.set('admin.secrets.encryptionKey', undefined)
    await actorDocument()
    expect((await rawRow())?.value).toMatch(/"d":/)

    strapi.config.set('admin.secrets.encryptionKey', encryptionKey)
    await keysService.encryptStoredActorKeys(strapi)
    const [entry] = await storedEntries()
    expect(isEncryptedEnvelope(entry.privateJwk)).toBe(true)
  })
})
