import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { generateCryptoKeyPair } from '@fedify/fedify'
import type { webcrypto } from 'node:crypto'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { encryptText } from '../server/src/utils/key-encryption'

const ACTIVITY_JSON = 'application/activity+json'
/** Neutral actor handle and URI path, set before Strapi boots so WebFinger and the actor URL agree. */
const ACTOR_IDENTIFIER = 'actor'
const CORE_STORE_KEY_PREFIX = 'plugin_fediverse_'
/** The body of every key failure: the cause is only in the server log. */
const GENERIC_BODY = 'Internal Server Error'

type JsonWebKey = webcrypto.JsonWebKey
type CryptoKey = webcrypto.CryptoKey
type CryptoKeyPair = webcrypto.CryptoKeyPair

interface ActorDocument {
  id: string
  publicKey?: { id?: string; publicKeyPem?: string }
}

/** The part of the plugin's `keys` service these tests call. */
interface KeysService {
  getActorKeyPairs(strapi: unknown): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }[]>
}

interface StoredEntry {
  name: string
  publicJwk: JsonWebKey
  privateJwk: unknown
  algorithm: string
  generatedAt: string
}

/** The plugin store key of the default site's actor key: one entry per site, `keyPairs:<site>`. */
async function actorKeyStoreKey(): Promise<string> {
  const site = (await strapi.db
    .query('plugin::micelio.site')
    .findOne({ where: { isDefault: true }, select: ['documentId'] })) as { documentId: string }
  return `keyPairs:${site.documentId}`
}

/** The core store row exactly as the database holds it. */
async function rawRow(): Promise<{ id: number; value: string } | null> {
  return strapi.db
    .query('strapi::core-store')
    .findOne({ where: { key: `${CORE_STORE_KEY_PREFIX}${await actorKeyStoreKey()}` } })
}

async function writeEntries(value: StoredEntry[]): Promise<void> {
  await strapi
    .store({ type: 'plugin', name: 'fediverse' })
    .set({ key: await actorKeyStoreKey(), value })
}

/** A stored entry as the plugin writes it: public JWK plain, private JWK encrypted. */
async function storedEntry(
  name: string,
  pair: CryptoKeyPair,
  transform: (jwk: JsonWebKey) => JsonWebKey = (jwk) => jwk
): Promise<StoredEntry> {
  const key = strapi.config.get('admin.secrets.encryptionKey') as string
  const privateJwk = transform(await crypto.subtle.exportKey('jwk', pair.privateKey))
  return {
    name,
    publicJwk: transform(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    privateJwk: encryptText(JSON.stringify(privateJwk), key),
    algorithm: pair.publicKey.algorithm.name,
    generatedAt: '',
  }
}

/** The base64 body of a PEM, for comparing with an SPKI export. */
function pemBody(pem: string | undefined): string {
  return (pem ?? '').replace(/-----[^-]+-----|\s/g, '')
}

async function spkiBase64(key: CryptoKey): Promise<string> {
  return Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64')
}

describe('Fediverse actor key imported by its JWK type', () => {
  let actorUrl: string
  let keysService: KeysService

  async function fetchActor(): Promise<Response> {
    return fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
  }

  async function actorDocument(): Promise<ActorDocument> {
    const res = await fetchActor()
    expect(res.status).toBe(200)
    return (await res.json()) as ActorDocument
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = ACTOR_IDENTIFIER
    process.env.FRONTEND_URL = 'https://blog.example.test'
    await setupStrapi()

    actorUrl = `http://${serverHost()}/fediverse/user/${ACTOR_IDENTIFIER}`
    keysService = strapi.plugin('fediverse').service('keys')
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  it('round-trips a stored encrypted RSA pair unchanged', async () => {
    const rsa = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5')
    const entry = await storedEntry('main-key', rsa)
    await writeEntries([entry])
    const before = await rawRow()

    const [pair] = await keysService.getActorKeyPairs(strapi)
    expect(pair.privateKey.algorithm).toMatchObject({
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
    })
    expect(pair.privateKey.usages).toEqual(['sign'])
    expect(pair.publicKey.usages).toEqual(['verify'])
    const exported = await crypto.subtle.exportKey('jwk', rsa.privateKey)
    expect((await crypto.subtle.exportKey('jwk', pair.privateKey)).d).toBe(exported.d)

    const document = await actorDocument()
    expect(pemBody(document.publicKey?.publicKeyPem)).toBe(await spkiBase64(rsa.publicKey))
    expect(await rawRow()).toEqual(before)
  })

  it('still loads a stored RSA JWK that carries no alg', async () => {
    const rsa = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5')
    await writeEntries([await storedEntry('main-key', rsa, ({ alg: _alg, ...jwk }) => jwk)])

    const [pair] = await keysService.getActorKeyPairs(strapi)
    expect(pair.privateKey.algorithm.name).toBe('RSASSA-PKCS1-v1_5')
    expect(await spkiBase64(pair.publicKey)).toBe(await spkiBase64(rsa.publicKey))
  })

  it('publishes the first RSA key as publicKey when an Ed25519 key is stored first', async () => {
    const ed25519 = await generateCryptoKeyPair('Ed25519')
    const rsa = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5')
    await writeEntries([await storedEntry('ed-key', ed25519), await storedEntry('main-key', rsa)])

    const pairs = await keysService.getActorKeyPairs(strapi)
    expect(pairs.map((pair) => pair.privateKey.algorithm.name)).toEqual([
      'Ed25519',
      'RSASSA-PKCS1-v1_5',
    ])

    const document = await actorDocument()
    expect(pemBody(document.publicKey?.publicKeyPem)).toBe(await spkiBase64(rsa.publicKey))
  })

  it('fails closed with the generic 500 on an unsupported key type, logging only its name', async () => {
    const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    await writeEntries([await storedEntry('main-key', ec)])
    const before = await rawRow()
    const logError = vi.spyOn(strapi.log, 'error')

    try {
      await expect(keysService.getActorKeyPairs(strapi)).rejects.toThrow(TypeError)

      const res = await fetchActor()
      expect(res.status).toBe(500)
      expect(await res.text()).toBe(GENERIC_BODY)

      const lines = logError.mock.calls.map(([message]) => String(message))
      expect(lines.some((line) => line.includes('could not be loaded (TypeError)'))).toBe(true)
      for (const line of lines) expect(line).not.toMatch(/"d":|privateJwk|\n\s+at /)
      expect(await rawRow()).toEqual(before)
    } finally {
      logError.mockRestore()
    }
  })
})
