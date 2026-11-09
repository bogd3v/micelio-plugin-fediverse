import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createExponentialBackoffPolicy } from '@fedify/fedify'
import { setupStrapi, cleanupStrapi } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { activityTypeFor } from '../server/src/services/federated-articles'
import type followers from '../server/src/services/followers'
import type federatedArticles from '../server/src/services/federated-articles'

const ARTICLE_UID = 'api::article.article'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const STORE = { type: 'plugin', name: 'fediverse' } as const
const LEGACY_KEY = 'federatedArticles'

interface Row {
  articleDocumentId: string
  status: string
  createSentAt: string | null
  lastActivityAt: string | null
  lastActivityType: string | null
  attempts: number
  lastError: string | null
}

describe('activityTypeFor', () => {
  const row = (status: string, lastActivityType: string | null) =>
    ({ status, lastActivityType }) as never

  it('sends a Create unless remote servers can already hold the article', () => {
    expect(activityTypeFor(null)).toBe('Create')
    expect(activityTypeFor(row('deleted', 'Delete'))).toBe('Create')
    expect(activityTypeFor(row('created', 'Create'))).toBe('Update')
    expect(activityTypeFor(row('updated', 'Update'))).toBe('Update')
  })

  it('keeps a failed Create a Create, and a failed Update an Update', () => {
    expect(activityTypeFor(row('failed', 'Create'))).toBe('Create')
    expect(activityTypeFor(row('failed', 'Update'))).toBe('Update')
    expect(activityTypeFor(row('failed', 'Delete'))).toBe('Create')
  })
})

describe('Fediverse federation (federated article state)', () => {
  let followersService: ReturnType<typeof followers>
  let service: ReturnType<typeof federatedArticles>
  let remote: RemoteActor
  const articleIds: string[] = []

  const uniqueTitle = (label: string) => `${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const rowsOf = async (articleDocumentId: string) =>
    (await strapi.db.query(ROW_UID).findMany({ where: { articleDocumentId } })) as Row[]
  const rowOf = async (articleDocumentId: string) => (await rowsOf(articleDocumentId))[0]
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)

  async function createArticle() {
    const title = uniqueTitle('State article')
    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title, slug: slugify(title), description: 'A short excerpt.' } })
    articleIds.push(draft.documentId)
    return draft
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()

    followersService = strapi.plugin('fediverse').service('followers')
    service = strapi.plugin('fediverse').service('federated-articles')
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader' })
    await followersService.recordFollower(strapi, {
      actorId: remote.actorUrl,
      inbox: remote.inboxUrl,
    })
  })

  afterEach(async () => {
    await remote.close()
    for (const row of await strapi.db.query(FOLLOWER_UID).findMany()) {
      await strapi.db.query(FOLLOWER_UID).delete({ where: { documentId: row.documentId } })
    }
  })

  afterAll(async () => {
    // In-flight fan-out runs after the document operation commits.
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await strapi.db.query(ROW_UID).deleteMany({})
    await strapi.store(STORE).delete({ key: LEGACY_KEY })
    await cleanupStrapi()
  })

  describe('row lifecycle', () => {
    it('records Create, Update and Delete on one row, and a re-publish after Delete is a Create again', async () => {
      const draft = await createArticle()
      const id = draft.documentId

      await strapi.documents(ARTICLE_UID).publish({ documentId: id })
      await waitUntil(() => deliveriesOf('Create').length === 1)
      const created = await rowOf(id)
      expect(created).toMatchObject({
        status: 'created',
        lastActivityType: 'Create',
        attempts: 1,
        lastError: null,
      })
      expect(created.createSentAt).not.toBeNull()
      expect(created.lastActivityAt).not.toBeNull()

      await strapi.documents(ARTICLE_UID).update({ documentId: id, data: { title: 'Edited' } })
      await strapi.documents(ARTICLE_UID).publish({ documentId: id })
      await waitUntil(() => deliveriesOf('Update').length === 1)
      const updated = await rowOf(id)
      expect(updated).toMatchObject({ status: 'updated', lastActivityType: 'Update' })
      expect(new Date(updated.createSentAt!).getTime()).toBe(
        new Date(created.createSentAt!).getTime()
      )

      await strapi.documents(ARTICLE_UID).unpublish({ documentId: id })
      await waitUntil(() => deliveriesOf('Delete').length === 1)
      expect(await rowOf(id)).toMatchObject({ status: 'deleted', lastActivityType: 'Delete' })

      await strapi.documents(ARTICLE_UID).publish({ documentId: id })
      await waitUntil(() => deliveriesOf('Create').length === 2)
      expect(await rowOf(id)).toMatchObject({ status: 'created', lastActivityType: 'Create' })
      expect(await rowsOf(id)).toHaveLength(1)
    })

    it('marks the row failed with a sanitized reason when delivery is abandoned', async () => {
      const row = await strapi.db
        .query(FOLLOWER_UID)
        .findOne({ where: { actorId: remote.actorUrl } })
      await strapi.db.query(FOLLOWER_UID).update({
        where: { documentId: row.documentId },
        data: { inbox: 'http://127.0.0.1:1/inbox?token=secret' },
      })
      // Two quick retries instead of Fedify's hours-long backoff.
      strapi.config.set(
        'plugin::fediverse.outboxRetryPolicy',
        createExponentialBackoffPolicy({
          initialDelay: { milliseconds: 20 },
          maxAttempts: 2,
          jitter: false,
        })
      )

      try {
        const draft = await createArticle()
        await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })

        const failed = await waitUntil(async () => {
          const current = await rowOf(draft.documentId)
          return current?.status === 'failed' ? current : null
        })
        expect(failed.lastActivityType).toBe('Create')
        expect(failed.attempts).toBe(3)
        expect(failed.lastError ?? '').not.toMatch(/\?|127\.0\.0\.1|secret/)
      } finally {
        strapi.config.set('plugin::fediverse.outboxRetryPolicy', undefined)
      }
    })
  })

  describe('recordSend', () => {
    it('leaves exactly one row when the same article is recorded concurrently', async () => {
      const articleDocumentId = `race-${Date.now()}`

      await Promise.all(
        Array.from({ length: 5 }, () => service.recordSend(strapi, articleDocumentId, 'Create'))
      )

      const rows = await rowsOf(articleDocumentId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'created', lastActivityType: 'Create' })
    })

    it('does not let a late failure overwrite a newer activity', async () => {
      const articleDocumentId = `late-${Date.now()}`
      const first = await service.recordSend(strapi, articleDocumentId, 'Create')
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      await service.recordSend(strapi, articleDocumentId, 'Update')

      await service.recordFailure(strapi, articleDocumentId, first, new Error('late'))

      expect(await rowOf(articleDocumentId)).toMatchObject({ status: 'updated', lastError: null })
    })
  })

  describe('migration of the plugin store key', () => {
    it('creates one row per stored id, and a second run creates and changes none', async () => {
      const ids = Array.from({ length: 4 }, (_, i) => `legacy-${Date.now()}-${i}`)
      await strapi.store(STORE).set({
        key: LEGACY_KEY,
        value: Object.fromEntries(ids.map((id) => [id, '2026-01-01T00:00:00.000Z'])),
      })
      const before = await strapi.db.query(ROW_UID).count()

      expect(await service.migrateFederatedArticles(strapi)).toBe(4)

      expect(await strapi.db.query(ROW_UID).count()).toBe(before + 4)
      const snapshot = await strapi.db
        .query(ROW_UID)
        .findMany({ where: { articleDocumentId: { $in: ids } }, orderBy: { id: 'asc' } })
      expect(snapshot).toHaveLength(4)
      for (const row of snapshot) {
        expect(row).toMatchObject({ status: 'created', createSentAt: null })
      }

      expect(await service.migrateFederatedArticles(strapi)).toBe(0)
      expect(await strapi.db.query(ROW_UID).count()).toBe(before + 4)
      expect(
        await strapi.db
          .query(ROW_UID)
          .findMany({ where: { articleDocumentId: { $in: ids } }, orderBy: { id: 'asc' } })
      ).toEqual(snapshot)
      // Left in place for one release line, so a rollback still finds it.
      expect(await strapi.store(STORE).get({ key: LEGACY_KEY })).not.toBeNull()
    })

    it('keeps the state of an article that already has a row', async () => {
      const id = `kept-${Date.now()}`
      await service.recordSend(strapi, id, 'Delete')
      await strapi
        .store(STORE)
        .set({ key: LEGACY_KEY, value: { [id]: '2026-01-01T00:00:00.000Z' } })

      await service.migrateFederatedArticles(strapi)

      expect(await rowsOf(id)).toHaveLength(1)
      expect(await rowOf(id)).toMatchObject({ status: 'deleted' })
    })

    it('treats an article from the old key as federated, so its next publish is an Update', async () => {
      const draft = await createArticle()
      await strapi.store(STORE).set({
        key: LEGACY_KEY,
        value: { [draft.documentId]: '2026-01-01T00:00:00.000Z' },
      })
      await service.migrateFederatedArticles(strapi)

      await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })

      await waitUntil(() => deliveriesOf('Update').length === 1)
      expect(deliveriesOf('Create')).toHaveLength(0)
    })
  })
})
