import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { setupStrapi, cleanupStrapi } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'

const ARTICLE_UID = 'api::article.article'
const COMMENT_UID = 'plugin::comments.comment'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const PASSWORD = 'Panel-admin-1'
const PROBLEM_JSON = /^application\/problem\+json/

interface FederationBody {
  documentId: string
  state: string
  lastActivityType: string | null
  attempts: number
  lastError: string | null
  counts: { likes: number; boosts: number; repliesApproved: number; repliesPending: number }
  canFederate: { allowed: boolean; code?: string }
}

describe('Fediverse article panel (admin routes)', () => {
  let remote: RemoteActor
  let superToken: string
  let readerToken: string
  let noAccessToken: string
  let publisherToken: string
  let spanishOnlyToken: string
  let adminCounter = 0

  const server = () => strapi.server.httpServer
  const federationUrl = (documentId: string, locale?: string) =>
    `/fediverse-panel/articles/${documentId}/federation${locale ? `?locale=${locale}` : ''}`
  const federateUrl = (documentId: string, locale?: string) =>
    `/fediverse-panel/articles/${documentId}/federate${locale ? `?locale=${locale}` : ''}`
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  const rowOf = (articleDocumentId: string) =>
    strapi.db.query(ROW_UID).findOne({ where: { articleDocumentId } })

  /** An admin with the given Content Manager permissions on articles, logged in. */
  async function adminWith(
    actions: string[],
    conditions: string[] = [],
    locales: string[] = ['en', 'es']
  ): Promise<string> {
    adminCounter += 1
    const role = await strapi
      .service('admin::role')
      .create({ name: `Panel role ${adminCounter}`, description: 'test' })
    if (actions.length > 0) {
      await strapi.service('admin::role').assignPermissions(
        role.id,
        actions.map((action) => ({
          action,
          subject: ARTICLE_UID,
          properties: { fields: ['title', 'slug'], locales },
          conditions,
        }))
      )
    }
    const email = `panel-admin-${adminCounter}@example.test`
    await strapi.service('admin::user').create({
      email,
      password: PASSWORD,
      firstname: 'Panel',
      lastname: 'Admin',
      isActive: true,
      roles: [role.id],
    })
    return login(email)
  }

  async function login(email: string): Promise<string> {
    const res = await request(server())
      .post('/admin/login')
      .send({ email, password: PASSWORD })
      .expect(200)
    return res.body.data.token ?? res.body.data.accessToken
  }

  async function createArticle({ publish }: { publish: boolean }) {
    const title = `Panel article ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: 'x' },
    })
    if (publish) {
      await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
      // Publishing queues a Create; let it settle, then forget it so the article looks
      // like one published while the plugin was off.
      await waitUntil(() => rowOf(draft.documentId))
      await waitUntil(() => deliveriesOf('Create').length >= 1)
      await strapi.db.query(ROW_UID).deleteMany({ where: { articleDocumentId: draft.documentId } })
      remote.inboxDeliveries.length = 0
    }
    return draft.documentId
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()

    // Creating the locale also gives the super admin its permissions on it.
    const locales = strapi.plugin('i18n').service('locales')
    if (!(await locales.findByCode('es')))
      await locales.create({ code: 'es', name: 'Spanish (es)' })

    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    await strapi.service('admin::user').create({
      email: 'panel-super@example.test',
      password: PASSWORD,
      firstname: 'Panel',
      lastname: 'Super',
      isActive: true,
      roles: [superAdmin.id],
    })
    superToken = await login('panel-super@example.test')
    readerToken = await adminWith(['plugin::content-manager.explorer.read'])
    noAccessToken = await adminWith([])
    publisherToken = await adminWith([
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.publish',
    ])
    spanishOnlyToken = await adminWith(
      ['plugin::content-manager.explorer.read', 'plugin::content-manager.explorer.publish'],
      [],
      ['es']
    )
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader' })
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterEach(async () => {
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })

  describe('GET /fediverse-panel/articles/:documentId/federation', () => {
    it('answers never federated for a published article that was never sent', async () => {
      const documentId = await createArticle({ publish: true })

      const res = await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200)

      const body = res.body as FederationBody
      expect(body).toMatchObject({
        documentId,
        state: 'never',
        lastActivityType: null,
        attempts: 0,
        lastError: null,
        canFederate: { allowed: true },
      })
    })

    it('answers the state of each kind of last activity and the failed reason', async () => {
      const documentId = await createArticle({ publish: true })
      const get = async () =>
        (
          await request(server())
            .get(federationUrl(documentId))
            .set('Authorization', `Bearer ${superToken}`)
            .expect(200)
        ).body as FederationBody

      await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(202)
      expect(await get()).toMatchObject({ state: 'created', lastActivityType: 'Create' })

      await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(202)
      expect(await get()).toMatchObject({ state: 'updated', lastActivityType: 'Update' })

      await strapi.db.query(ROW_UID).update({
        where: { articleDocumentId: documentId },
        data: { status: 'failed', attempts: 3, lastError: 'The inbox at [ip] answered HTTP 500' },
      })
      expect(await get()).toMatchObject({
        state: 'failed',
        attempts: 3,
        lastError: 'The inbox at [ip] answered HTTP 500',
      })
    })

    it('counts likes, boosts and approved and pending fediverse replies', async () => {
      const documentId = await createArticle({ publish: true })
      const interactions = strapi.plugin('fediverse').service('interactions')
      await interactions.recordInteraction(strapi, {
        type: 'like',
        actorId: 'https://remote.example.test/users/a',
        articleDocumentId: documentId,
      })
      await interactions.recordInteraction(strapi, {
        type: 'boost',
        actorId: 'https://remote.example.test/users/b',
        articleDocumentId: documentId,
      })
      const reply = (approvalStatus: 'APPROVED' | 'PENDING' | 'REJECTED', n: number) =>
        strapi.documents(COMMENT_UID).create({
          data: {
            content: 'A reply',
            related: `${ARTICLE_UID}:${documentId}`,
            approvalStatus,
            authorId: `https://remote.example.test/users/r${n}`,
            authorName: 'Replier',
            fediverseUri: `https://remote.example.test/users/r${n}/notes/1`,
          },
        })
      await reply('APPROVED', 1)
      await reply('APPROVED', 2)
      await reply('PENDING', 3)
      await reply('REJECTED', 4)
      // A local comment is not a fediverse reply.
      await strapi.documents(COMMENT_UID).create({
        data: {
          content: 'local',
          related: `${ARTICLE_UID}:${documentId}`,
          approvalStatus: 'PENDING',
          authorId: 'guest',
          authorName: 'Guest',
        },
      })

      const res = await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200)

      expect((res.body as FederationBody).counts).toEqual({
        likes: 1,
        boosts: 1,
        repliesApproved: 2,
        repliesPending: 1,
      })
    })

    it('says why a draft or another locale cannot be federated', async () => {
      const draftId = await createArticle({ publish: false })
      const draft = await request(server())
        .get(federationUrl(draftId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200)
      expect((draft.body as FederationBody).canFederate).toEqual({
        allowed: false,
        code: 'article-not-published',
      })

      const publishedId = await createArticle({ publish: true })
      await strapi.documents(ARTICLE_UID).update({
        documentId: publishedId,
        locale: 'es',
        data: { title: 'Artículo', slug: `articulo-${publishedId}`, description: 'x' },
      })
      const other = await request(server())
        .get(federationUrl(publishedId, 'es'))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200)
      expect((other.body as FederationBody).canFederate).toEqual({
        allowed: false,
        code: 'locale-not-federated',
      })
    })

    it('is a problem detail with a stable code for an unknown article', async () => {
      const res = await request(server())
        .get(federationUrl('does-not-exist'))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(404)

      expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(res.body).toMatchObject({ status: 404, code: 'article-not-found' })
    })

    it('answers 403 to a role with no access whether the article exists or not', async () => {
      const documentId = await createArticle({ publish: true })
      const get = (id: string) =>
        request(server())
          .get(federationUrl(id))
          .set('Authorization', `Bearer ${noAccessToken}`)
          .expect(403)

      // Same answer for an id that exists and for one that does not.
      expect((await get(documentId)).body.code).toBe('forbidden')
      expect((await get('does-not-exist')).body.code).toBe('forbidden')
    })

    it('applies the "is creator" condition to the article of its creator only', async () => {
      const documentId = await createArticle({ publish: true })
      const creator = await adminWith(
        ['plugin::content-manager.explorer.read'],
        ['admin::is-creator']
      )
      const creatorUser = await strapi.db
        .query('admin::user')
        .findOne({ where: { email: `panel-admin-${adminCounter}@example.test` } })
      await strapi.db
        .query(ARTICLE_UID)
        .updateMany({ where: { documentId }, data: { createdBy: creatorUser.id } })
      const other = await adminWith(
        ['plugin::content-manager.explorer.read'],
        ['admin::is-creator']
      )

      await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${creator}`)
        .expect(200)
      await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${other}`)
        .expect(403)
    })

    it('needs an admin session and the read permission', async () => {
      const documentId = await createArticle({ publish: true })

      await request(server()).get(federationUrl(documentId)).expect(401)
      await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', 'Bearer not-a-token')
        .expect(401)
      const denied = await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${noAccessToken}`)
        .expect(403)
      expect(denied.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(denied.body).toMatchObject({ status: 403, code: 'forbidden' })
      await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200)
    })
  })

  describe('POST /fediverse-panel/articles/:documentId/federate', () => {
    it('queues a Create for an article that was never federated, and the inbox receives it', async () => {
      const documentId = await createArticle({ publish: true })

      const res = await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(202)

      expect(res.body).toEqual({ activity: 'Create', queued: 1, skipped: 0 })
      await waitUntil(() => deliveriesOf('Create').length === 1)
      expect(await rowOf(documentId)).toMatchObject({ status: 'created' })
    })

    it('queues an Update for an article that was federated', async () => {
      const documentId = await createArticle({ publish: true })
      await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(202)
      await waitUntil(() => deliveriesOf('Create').length === 1)

      const res = await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(202)

      expect(res.body).toMatchObject({ activity: 'Update' })
      await waitUntil(() => deliveriesOf('Update').length === 1)
    })

    it('answers 409 with a problem detail for a draft and sends nothing', async () => {
      const documentId = await createArticle({ publish: false })

      const res = await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(409)

      expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(res.body).toMatchObject({
        type: 'about:blank',
        status: 409,
        code: 'article-not-published',
      })
      expect(typeof res.body.title).toBe('string')
      expect(typeof res.body.detail).toBe('string')
      expect(await rowOf(documentId)).toBeNull()
    })

    it('answers 409 locale-not-federated for another locale', async () => {
      const documentId = await createArticle({ publish: true })
      await strapi.documents(ARTICLE_UID).update({
        documentId,
        locale: 'es',
        data: { title: 'Artículo', slug: `articulo-${documentId}`, description: 'x' },
      })

      const res = await request(server())
        .post(federateUrl(documentId, 'es'))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(409)

      expect(res.body).toMatchObject({ code: 'locale-not-federated' })
    })

    it('lets a role that may read and publish, and is not the super admin, federate', async () => {
      const documentId = await createArticle({ publish: true })

      const res = await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${publisherToken}`)
        .expect(202)

      expect(res.body).toMatchObject({ activity: 'Create' })
    })

    it('refuses a role whose permissions cover another language only', async () => {
      const documentId = await createArticle({ publish: true })

      await request(server())
        .get(federationUrl(documentId))
        .set('Authorization', `Bearer ${spanishOnlyToken}`)
        .expect(403)
      await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${spanishOnlyToken}`)
        .expect(403)
      expect(await rowOf(documentId)).toBeNull()
    })

    it('answers 503 with a problem detail when the activity cannot be queued', async () => {
      const documentId = await createArticle({ publish: true })
      const log = vi.spyOn(strapi.log, 'error').mockImplementation(() => strapi.log)
      // The publisher builds its Fedify context from the public URL; an invalid one makes the
      // fan-out throw before anything is queued, as a failing queue backend would.
      const url = strapi.config.get('server.url')
      strapi.config.set('server.url', 'not a url')

      try {
        const res = await request(server())
          .post(federateUrl(documentId))
          .set('Authorization', `Bearer ${superToken}`)
          .expect(503)

        expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
        expect(res.body).toMatchObject({ status: 503, code: 'queue-unavailable' })
        expect(JSON.stringify(res.body)).not.toContain('queue database')
      } finally {
        strapi.config.set('server.url', url)
        log.mockRestore()
      }
    })

    it('answers 403 to an admin without the publish permission, and sends nothing', async () => {
      const documentId = await createArticle({ publish: true })

      await request(server()).post(federateUrl(documentId)).expect(401)
      const res = await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(403)

      expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(res.body).toMatchObject({ status: 403, code: 'forbidden' })
      expect(await rowOf(documentId)).toBeNull()
    })

    it('skips unreachable followers and says how many', async () => {
      const documentId = await createArticle({ publish: true })
      await strapi.db.query(FOLLOWER_UID).updateMany({
        where: { actorId: remote.actorUrl },
        data: { unreachableSince: new Date().toISOString() },
      })

      const res = await request(server())
        .post(federateUrl(documentId))
        .set('Authorization', `Bearer ${superToken}`)
        .expect(202)

      expect(res.body).toEqual({ activity: 'Create', queued: 0, skipped: 1 })
    })
  })
})
