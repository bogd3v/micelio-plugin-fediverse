import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { generateCryptoKeyPair } from '@fedify/fedify'
import { setupStrapi, cleanupStrapi } from './strapi'
import { encryptText } from '../server/src/utils/key-encryption'

const SITE_UID = 'plugin::micelio.site'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const INTERACTION_UID = 'plugin::fediverse.interaction'
const FEDERATED_ARTICLE_UID = 'plugin::fediverse.federated-article'
const TYPES = {
  followers: FOLLOWER_UID,
  interactions: INTERACTION_UID,
  federatedArticles: FEDERATED_ARTICLE_UID,
} as const
const STORE = { type: 'plugin', name: 'fediverse' } as const
/** The key the actor key was stored under before the sites. */
const LEGACY_KEY = 'keyPairs'

interface Report {
  followers: number
  interactions: number
  federatedArticles: number
  actorKeys: number
}

interface KeysService {
  verifyStoredActorKey(strapi: unknown, site?: string): Promise<'ok' | 'missing'>
  getStoredKeyPairEntries(strapi: unknown, site?: string): Promise<unknown[] | null>
}

const keys = (): KeysService => strapi.plugin('fediverse').service('keys')
const adoptDefaultSite = (): Promise<Report> =>
  strapi.plugin('fediverse').service('default-site').adoptDefaultSite(strapi)

async function defaultSite(): Promise<{ id: number; documentId: string }> {
  return (await strapi.db
    .query(SITE_UID)
    .findOne({ where: { isDefault: true }, select: ['id', 'documentId'] })) as {
    id: number
    documentId: string
  }
}

/** Rows of one type: all of them, those with no site and those on the site. */
async function rowsOf(uid: string, site?: string) {
  const query = strapi.db.query(uid)
  return {
    all: await query.count(),
    withoutSite: await query.count({ where: { site: null } }),
    onSite: site ? await query.count({ where: { site: { documentId: site } } }) : 0,
  }
}

async function countsPerType(): Promise<Record<keyof typeof TYPES, number>> {
  const counts = {} as Record<keyof typeof TYPES, number>
  for (const [name, uid] of Object.entries(TYPES)) {
    counts[name as keyof typeof TYPES] = await strapi.db.query(uid).count()
  }
  return counts
}

/** A stored key entry as the plugin writes it: public JWK plain, private JWK encrypted. */
async function storedKey(): Promise<unknown[]> {
  const pair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5')
  const encryptionKey = strapi.config.get('admin.secrets.encryptionKey') as string
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return [
    {
      name: 'main-key',
      publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
      privateJwk: encryptText(JSON.stringify(privateJwk), encryptionKey),
      algorithm: 'RSASSA-PKCS1-v1_5',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]
}

/**
 * Leaves the database as `micelio-cms` 0.6 left it: followers, interactions and federated-article
 * rows with no site, and the one actor key under `keyPairs`. `db.query` writes a row without the
 * required relation, as the plugin did before the sites.
 *
 * @returns The key stored under `keyPairs`.
 */
async function seedBeforeTheSites(): Promise<unknown[]> {
  for (const [actorId, blocked] of [
    ['https://one.example/users/a', false],
    ['https://two.example/users/b', false],
    ['https://three.example/users/c', true],
  ] as const) {
    await strapi.db.query(FOLLOWER_UID).create({
      data: { actorId, handle: '@a@one.example', inbox: `${actorId}/inbox`, blocked },
    })
  }
  for (const [type, actorId, article] of [
    ['like', 'https://one.example/users/a', 'article-one'],
    ['boost', 'https://two.example/users/b', 'article-one'],
  ] as const) {
    await strapi.db.query(INTERACTION_UID).create({
      data: { type, actorId, articleDocumentId: article, interactionKey: `${type}|${actorId}` },
    })
  }
  for (const article of ['article-one', 'article-two']) {
    await strapi.db.query(FEDERATED_ARTICLE_UID).create({
      data: { articleDocumentId: article, status: 'created', attempts: 1 },
    })
  }
  const store = strapi.store(STORE)
  const legacy = await storedKey()
  await store.set({ key: LEGACY_KEY, value: legacy })
  await store.delete({ key: `${LEGACY_KEY}:${(await defaultSite()).documentId}` })
  return legacy
}

/** Stops Strapi and boots it again on the same database. */
async function reboot(): Promise<void> {
  await cleanupStrapi({ keepDatabase: true })
  await setupStrapi({ keepDatabase: true })
}

describe('The default site adopts what the plugin stored before the sites', () => {
  beforeEach(async () => {
    await cleanupStrapi()
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    await setupStrapi()
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  it('puts every row and the key pair on the default site, and a second boot changes nothing', async () => {
    const legacy = await seedBeforeTheSites()

    await reboot()

    const site = (await defaultSite()).documentId
    for (const uid of Object.values(TYPES)) {
      const rows = await rowsOf(uid, site)
      expect(rows.withoutSite).toBe(0)
      expect(rows.onSite).toBe(rows.all)
    }
    expect(await rowsOf(FOLLOWER_UID, site)).toMatchObject({ all: 3, onSite: 3 })
    expect(await rowsOf(INTERACTION_UID, site)).toMatchObject({ all: 2, onSite: 2 })
    expect(await rowsOf(FEDERATED_ARTICLE_UID, site)).toMatchObject({ all: 2, onSite: 2 })
    // The key is readable, and it is the one that was stored: the actor identity does not change.
    await expect(keys().verifyStoredActorKey(strapi)).resolves.toBe('ok')
    expect(await keys().getStoredKeyPairEntries(strapi)).toEqual(legacy)
    // The entry from before the sites stays for one release line, so a rollback finds it.
    expect(await strapi.store(STORE).get({ key: LEGACY_KEY })).toEqual(legacy)

    const snapshot = async () => ({
      followers: await strapi.db.query(FOLLOWER_UID).findMany({ orderBy: { id: 'asc' } }),
      interactions: await strapi.db.query(INTERACTION_UID).findMany({ orderBy: { id: 'asc' } }),
      federatedArticles: await strapi.db
        .query(FEDERATED_ARTICLE_UID)
        .findMany({ orderBy: { id: 'asc' } }),
      key: await strapi.store(STORE).get({ key: `${LEGACY_KEY}:${site}` }),
    })
    const first = await snapshot()

    await reboot()

    await expect(adoptDefaultSite()).resolves.toEqual({
      followers: 0,
      interactions: 0,
      federatedArticles: 0,
      actorKeys: 0,
    })
    expect(await snapshot()).toEqual(first)
  })

  it('keeps the number of rows of each type', async () => {
    await seedBeforeTheSites()
    const before = await countsPerType()

    await reboot()

    const after = await countsPerType()
    const site = (await defaultSite()).documentId
    const onSite = {
      followers: (await rowsOf(FOLLOWER_UID, site)).onSite,
      interactions: (await rowsOf(INTERACTION_UID, site)).onSite,
      federatedArticles: (await rowsOf(FEDERATED_ARTICLE_UID, site)).onSite,
    }
    process.stdout.write(`rows per type before the backfill ${JSON.stringify(before)}\n`)
    process.stdout.write(`rows per type after the backfill  ${JSON.stringify(after)}\n`)
    expect(after).toEqual(before)
    // And every one of them is on the default site: nothing was left behind.
    expect(onSite).toEqual(before)
    expect(before).toEqual({ followers: 3, interactions: 2, federatedArticles: 2 })
  })

  it("leaves no row without a site when the package's bootstrap runs before the core's", async () => {
    await seedBeforeTheSites()
    // The instance had no site yet: the core creates the default one in its own bootstrap.
    await strapi.db.query(SITE_UID).deleteMany({ where: { id: { $notNull: true } } })
    const legacy = await strapi.store(STORE).get({ key: LEGACY_KEY })

    await reboot()

    // The precondition of the test: Strapi bootstraps the plugins in this order.
    const order = Object.keys(strapi.plugins)
    expect(order.indexOf('fediverse')).toBeLessThan(order.indexOf('micelio'))
    const site = (await defaultSite()).documentId
    for (const uid of Object.values(TYPES)) {
      const rows = await rowsOf(uid, site)
      expect(rows.withoutSite).toBe(0)
      expect(rows.onSite).toBe(rows.all)
    }
    expect(await countsPerType()).toEqual({ followers: 3, interactions: 2, federatedArticles: 2 })
    await expect(keys().verifyStoredActorKey(strapi)).resolves.toBe('ok')
    expect(await keys().getStoredKeyPairEntries(strapi)).toEqual(legacy)
  })

  it('gives a fresh instance its key entry from siteCreated', async () => {
    // `beforeEach` booted on an empty database: the core created the default site after this
    // package's bootstrap, and the hook created the key entry.
    await expect(keys().verifyStoredActorKey(strapi)).resolves.toBe('ok')
    expect(await strapi.store(STORE).get({ key: LEGACY_KEY })).toBeNull()
    const entries = await keys().getStoredKeyPairEntries(strapi)
    expect(entries).toHaveLength(1)
  })

  it('gives the default site the rows made from the old federatedArticles store key', async () => {
    await strapi.store(STORE).set({
      key: 'federatedArticles',
      value: { 'legacy-article-one': '2026-01-01T00:00:00.000Z' },
    })

    await reboot()

    const site = (await defaultSite()).documentId
    const row = await strapi.db.query(FEDERATED_ARTICLE_UID).findOne({
      where: { articleDocumentId: 'legacy-article-one', site: { documentId: site } },
    })
    expect(row).toMatchObject({ status: 'created' })
  })

  it('never overwrites the key entry a site already has', async () => {
    const before = await keys().getStoredKeyPairEntries(strapi)
    await strapi.store(STORE).set({ key: LEGACY_KEY, value: await storedKey() })

    await expect(adoptDefaultSite()).resolves.toMatchObject({ actorKeys: 0 })

    expect(await keys().getStoredKeyPairEntries(strapi)).toEqual(before)
  })
})
