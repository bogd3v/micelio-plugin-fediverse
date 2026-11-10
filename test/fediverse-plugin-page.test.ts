import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import request from 'supertest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { defaultSiteRelation } from './helpers/categories'
import en from '../admin/src/translations/en.json'
import es from '../admin/src/translations/es.json'

const ARTICLE_UID = 'api::article.article'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const PASSWORD = 'Page-admin-1'
const PROBLEM_JSON = /^application\/problem\+json/
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

interface Check {
  id: string
  ok: boolean | null
  code: string | null
  value: string | number | null
}

describe('Fediverse plugin page (admin routes)', () => {
  let remote: RemoteActor
  let superToken: string
  let readerToken: string
  let managerToken: string
  let noPermissionToken: string
  let manageOnlyToken: string
  let adminCounter = 0
  let host: string
  const savedUrl = process.env.URL

  const server = () => strapi.server.httpServer
  const api = (path: string) => `/fediverse-panel${path}`
  const as = (token: string) => ({ Authorization: `Bearer ${token}` })
  const rowOf = (articleDocumentId: string) =>
    strapi.db.query(ROW_UID).findOne({ where: { articleDocumentId } })
  const followerOf = (actorId: string) =>
    strapi.db.query(FOLLOWER_UID).findOne({ where: { actorId } })

  async function adminWith(actions: string[]): Promise<string> {
    adminCounter += 1
    const role = await strapi
      .service('admin::role')
      .create({ name: `Page role ${adminCounter}`, description: 'test' })
    if (actions.length > 0) {
      await strapi.service('admin::role').assignPermissions(
        role.id,
        actions.map((action) => ({ action, subject: null, properties: {}, conditions: [] }))
      )
    }
    const email = `page-admin-${adminCounter}@example.test`
    await strapi.service('admin::user').create({
      email,
      password: PASSWORD,
      firstname: 'Page',
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

  async function checks(): Promise<Record<string, Check>> {
    const res = await request(server()).get(api('/diagnostics')).set(as(superToken)).expect(200)
    return Object.fromEntries((res.body.checks as Check[]).map((check) => [check.id, check]))
  }

  /** A server that answers every request with `status` and `body`, standing in for the CMS's public address. */
  async function fakeOrigin(status: number, body: string) {
    const fake = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/jrd+json' })
      res.end(body)
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const { port } = fake.address() as AddressInfo
    return {
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => fake.close(() => resolve())),
    }
  }

  async function publishedArticle(title: string) {
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: 'x' },
    })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    await waitUntil(() => rowOf(draft.documentId))
    return draft.documentId
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    delete process.env.URL
    await setupStrapi()
    host = serverHost()

    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    await strapi.service('admin::user').create({
      email: 'page-super@example.test',
      password: PASSWORD,
      firstname: 'Page',
      lastname: 'Super',
      isActive: true,
      roles: [superAdmin.id],
    })
    superToken = await login('page-super@example.test')
    readerToken = await adminWith(['plugin::fediverse.read'])
    managerToken = await adminWith(['plugin::fediverse.read', 'plugin::fediverse.manage'])
    noPermissionToken = await adminWith([])
    manageOnlyToken = await adminWith(['plugin::fediverse.manage'])
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader' })
  })

  afterEach(async () => {
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
    if (savedUrl === undefined) delete process.env.URL
    else process.env.URL = savedUrl
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })

  describe('diagnostics', () => {
    it('fails the public URL when it is missing, and skips the WebFinger check', async () => {
      delete process.env.URL

      const result = await checks()

      expect(result['public-url']).toMatchObject({ ok: false, code: 'url-missing' })
      expect(result.webfinger).toMatchObject({ ok: false, code: 'webfinger-skipped' })
    })

    it('fails the public URL when it is not https, and passes WebFinger against the real server', async () => {
      process.env.URL = `http://${host}`

      const result = await checks()

      expect(result['public-url']).toMatchObject({ ok: false, code: 'url-not-https' })
      expect(result.webfinger).toMatchObject({ ok: true, code: null })
    })

    it('fails WebFinger when the public address answers 404, is unreachable, or names another subject', async () => {
      const notFound = await fakeOrigin(404, 'nope')
      const wrong = await fakeOrigin(200, JSON.stringify({ subject: 'acct:someone@else.test' }))
      try {
        process.env.URL = notFound.origin
        expect((await checks()).webfinger).toMatchObject({
          ok: false,
          code: 'webfinger-not-found',
        })

        process.env.URL = wrong.origin
        expect((await checks()).webfinger).toMatchObject({
          ok: false,
          code: 'webfinger-wrong-subject',
        })

        process.env.URL = 'http://127.0.0.1:1'
        expect((await checks()).webfinger).toMatchObject({
          ok: false,
          code: 'webfinger-unreachable',
        })
      } finally {
        await notFound.close()
        await wrong.close()
      }
    })

    it('fails the actor key with a wrong ENCRYPTION_KEY and names no key material', async () => {
      // The page only reads the key: make sure one exists, encrypted under the test key.
      await strapi.plugin('fediverse').service('keys').getActorKeyPairs(strapi)
      expect((await checks())['actor-key']).toMatchObject({ ok: true })
      const real = strapi.config.get('admin.secrets.encryptionKey')
      strapi.config.set('admin.secrets.encryptionKey', 'a-different-encryption-key-0000000')
      try {
        const result = await checks()

        expect(result['actor-key']).toMatchObject({
          ok: false,
          code: 'actor-key-missing-encryption-key',
        })
        expect(JSON.stringify(result['actor-key'])).not.toMatch(/privateJwk|"d"/)
      } finally {
        strapi.config.set('admin.secrets.encryptionKey', real)
      }
    })

    it('reports a missing actor key and does not create one: a read route writes nothing', async () => {
      const store = strapi.store({ type: 'plugin', name: 'fediverse' })
      const site = (await strapi.db
        .query('plugin::micelio.site')
        .findOne({ where: { isDefault: true }, select: ['documentId'] })) as { documentId: string }
      const keyName = `keyPairs:${site.documentId}`
      const saved = await store.get({ key: keyName })
      await store.delete({ key: keyName })
      try {
        const result = await checks()

        expect(result['actor-key']).toMatchObject({ ok: false, code: 'actor-key-missing' })
        expect(await store.get({ key: keyName })).toBeNull()
      } finally {
        await store.set({ key: keyName, value: saved })
      }
    })

    it('reports the backend, the followers and the refused inbox deliveries of the last 24 hours', async () => {
      await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      const before = Number((await checks())['inbox-refusals'].value)
      // An unsigned delivery is refused with a 401.
      await request(server())
        .post('/fediverse/inbox')
        .set('Content-Type', 'application/activity+json')
        .send({
          '@context': AS_CONTEXT,
          id: `${remote.actorUrl}/activities/unsigned-1`,
          type: 'Like',
          actor: remote.actorUrl,
          object: `http://${host}/fediverse/articles/anything`,
        })
        .expect(401)

      const result = await checks()

      // The queue and the counter live where Strapi's database is: PostgreSQL, or memory on SQLite.
      expect(result.backend.value).toBe(process.env.TEST_DATABASE_URL ? 'postgres' : 'memory')
      expect(result.followers.value).toBe(1)
      await waitUntil(async () => Number((await checks())['inbox-refusals'].value) === before + 1)
    })

    it('has a fix text, in both languages, for every failing condition', () => {
      const codes = [
        'url-missing',
        'url-not-https',
        'actor-key-unreadable',
        'actor-key-missing',
        'actor-key-missing-encryption-key',
        'webfinger-skipped',
        'webfinger-unreachable',
        'webfinger-not-found',
        'webfinger-wrong-subject',
      ]
      for (const code of codes) {
        expect(Object.keys(en)).toContain(`fediverse.page.fix.${code}`)
        expect(Object.keys(es)).toContain(`fediverse.page.fix.${code}`)
      }
    })
  })

  describe('followers', () => {
    const follow = (actor: RemoteActor) =>
      actor.postSignedActivity(`http://${host}/fediverse/user/devbog/inbox`, {
        '@context': AS_CONTEXT,
        id: `${actor.actorUrl}/follows/${Date.now()}`,
        type: 'Follow',
        actor: actor.actorUrl,
        object: `http://${host}/fediverse/user/devbog`,
      })

    it('lists the followers with what their row stores, and no more', async () => {
      await strapi.plugin('fediverse').service('followers').recordFollower(strapi, {
        actorId: remote.actorUrl,
        inbox: remote.inboxUrl,
        handle: '@reader@remote.example.test',
        name: 'Reader',
      })

      const res = await request(server()).get(api('/followers')).set(as(superToken)).expect(200)

      expect(res.body.followers).toHaveLength(1)
      expect(Object.keys(res.body.followers[0]).sort()).toEqual(
        ['blocked', 'documentId', 'handle', 'name', 'since', 'unreachableSince'].sort()
      )
      expect(res.body.followers[0]).toMatchObject({
        handle: '@reader@remote.example.test',
        name: 'Reader',
        blocked: false,
        unreachableSince: null,
      })
    })

    it('blocks a follower so that its Follow gets no answer, and unblocks it', async () => {
      const sentinel = await createRemoteActor({ preferredUsername: 'sentinel' })
      try {
        const row = await strapi
          .plugin('fediverse')
          .service('followers')
          .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })

        const blocked = await request(server())
          .post(api(`/followers/${row.documentId}/block`))
          .set(as(managerToken))
          .expect(200)
        expect(blocked.body).toEqual({ blocked: true })
        expect((await followerOf(remote.actorUrl)).blocked).toBe(true)

        expect((await follow(remote)).ok).toBe(true)
        expect((await follow(sentinel)).ok).toBe(true)
        await waitUntil(() => sentinel.inboxDeliveries.find((a) => a.type === 'Accept'))
        expect(remote.inboxDeliveries.find((a) => a.type === 'Accept')).toBeUndefined()

        await request(server())
          .post(api(`/followers/${row.documentId}/unblock`))
          .set(as(managerToken))
          .expect(200)
        expect((await followerOf(remote.actorUrl)).blocked).toBe(false)
        expect(await strapi.plugin('fediverse').service('followers').countFollowers(strapi)).toBe(2)
      } finally {
        await sentinel.close()
      }
    })

    it('unblocks every row of an actor that has a duplicate, so it is not left blocked', async () => {
      const first = await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      await strapi.db.query(FOLLOWER_UID).create({
        data: {
          actorId: remote.actorUrl,
          inbox: remote.inboxUrl,
          blocked: true,
          site: await defaultSiteRelation(),
        },
      })

      await request(server())
        .post(api(`/followers/${first.documentId}/unblock`))
        .set(as(managerToken))
        .expect(200)

      expect(await strapi.db.query(FOLLOWER_UID).count({ where: { blocked: true } })).toBe(0)
    })

    it('is a problem detail for a follower that does not exist', async () => {
      const res = await request(server())
        .post(api('/followers/nope/block'))
        .set(as(managerToken))
        .expect(404)

      expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(res.body).toMatchObject({ code: 'follower-not-found' })
    })
  })

  describe('failures', () => {
    async function failedRow(
      title: string,
      type: 'Create' | 'Update' | 'Delete' = 'Create'
    ): Promise<string> {
      const documentId = await publishedArticle(title)
      await strapi.db.query(ROW_UID).update({
        where: { articleDocumentId: documentId },
        data: {
          status: 'failed',
          lastActivityType: type,
          attempts: 3,
          lastError: 'The inbox at [ip] answered HTTP 500',
        },
      })
      return documentId
    }

    it('lists the failed rows with the article title and the reason', async () => {
      const documentId = await failedRow(`Failing article ${Date.now()}`)

      const res = await request(server()).get(api('/failures')).set(as(superToken)).expect(200)

      const row = (res.body.failures as Array<Record<string, unknown>>).find(
        (failure) => failure.articleDocumentId === documentId
      )
      expect(row).toMatchObject({
        attempts: 3,
        lastError: 'The inbox at [ip] answered HTTP 500',
        lastActivityType: 'Create',
      })
      expect(String(row?.title)).toContain('Failing article')
    })

    it('retries a failed article: the activity is queued again, the inbox gets it, and it is no longer failed', async () => {
      await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      const documentId = await failedRow(`Retried article ${Date.now()}`)
      remote.inboxDeliveries.length = 0

      const res = await request(server())
        .post(api(`/failures/${documentId}/retry`))
        .set(as(managerToken))
        .expect(202)

      // A failed Create is sent as a Create: an Update of a post a follower never got is ignored.
      expect(res.body).toMatchObject({ activity: 'Create', queued: 1, skipped: 0 })
      await waitUntil(() => remote.inboxDeliveries.find((a) => a.type === 'Create'))
      expect(remote.inboxDeliveries.find((a) => a.type === 'Update')).toBeUndefined()
      expect(await rowOf(documentId)).toMatchObject({ status: 'created', lastError: null })
    })

    it('sends a failed Update again as an Update', async () => {
      await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      const documentId = await failedRow(`Updated article ${Date.now()}`, 'Update')
      remote.inboxDeliveries.length = 0

      const res = await request(server())
        .post(api(`/failures/${documentId}/retry`))
        .set(as(managerToken))
        .expect(202)

      expect(res.body).toMatchObject({ activity: 'Update' })
      await waitUntil(() => remote.inboxDeliveries.find((a) => a.type === 'Update'))
    })

    it('sends a failed Delete again as a Delete', async () => {
      await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      const documentId = await publishedArticle(`Retracted article ${Date.now()}`)
      await strapi.documents(ARTICLE_UID).unpublish({ documentId })
      // The Delete of the unpublish arrives first; only then is the inbox cleared.
      await waitUntil(() => remote.inboxDeliveries.find((a) => a.type === 'Delete'))
      await waitUntil(async () => (await rowOf(documentId))?.status === 'deleted')
      await strapi.db.query(ROW_UID).update({
        where: { articleDocumentId: documentId },
        data: { status: 'failed', lastActivityType: 'Delete', attempts: 3, lastError: 'x' },
      })
      remote.inboxDeliveries.length = 0

      const res = await request(server())
        .post(api(`/failures/${documentId}/retry`))
        .set(as(managerToken))
        .expect(202)

      expect(res.body).toMatchObject({ activity: 'Delete' })
      await waitUntil(() => remote.inboxDeliveries.find((a) => a.type === 'Delete'))
      expect(await rowOf(documentId)).toMatchObject({ status: 'deleted' })
    })

    it('sends a failed Delete as a Create when the article was published again', async () => {
      await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      const documentId = await failedRow(`Republished article ${Date.now()}`, 'Delete')
      remote.inboxDeliveries.length = 0

      const res = await request(server())
        .post(api(`/failures/${documentId}/retry`))
        .set(as(managerToken))
        .expect(202)

      expect(res.body).toMatchObject({ activity: 'Create' })
    })

    it('answers 409 with a problem detail when there is nothing to retry', async () => {
      const documentId = await publishedArticle(`Healthy article ${Date.now()}`)

      const res = await request(server())
        .post(api(`/failures/${documentId}/retry`))
        .set(as(managerToken))
        .expect(409)

      expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
      expect(res.body).toMatchObject({ status: 409, code: 'not-failed' })
    })
  })

  describe('permissions', () => {
    it('needs an admin session', async () => {
      await request(server()).get(api('/diagnostics')).expect(401)
      await request(server()).post(api('/followers/x/block')).expect(401)
    })

    it('refuses a role with no plugin permission everywhere', async () => {
      for (const path of ['/diagnostics', '/followers', '/failures']) {
        const res = await request(server()).get(api(path)).set(as(noPermissionToken)).expect(403)
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON)
        expect(res.body).toMatchObject({ status: 403, code: 'forbidden' })
      }
    })

    it('refuses a role with manage but not read the page, which needs read to open', async () => {
      for (const path of ['/diagnostics', '/followers', '/failures']) {
        await request(server()).get(api(path)).set(as(manageOnlyToken)).expect(403)
      }
    })

    it('lets a role with read only read, and refuses block, unblock and retry', async () => {
      const row = await strapi
        .plugin('fediverse')
        .service('followers')
        .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      for (const path of ['/diagnostics', '/followers', '/failures']) {
        await request(server()).get(api(path)).set(as(readerToken)).expect(200)
      }

      for (const path of [
        `/followers/${row.documentId}/block`,
        `/followers/${row.documentId}/unblock`,
        '/failures/anything/retry',
      ]) {
        const res = await request(server()).post(api(path)).set(as(readerToken)).expect(403)
        expect(res.body).toMatchObject({ code: 'forbidden' })
      }
      expect((await followerOf(remote.actorUrl)).blocked).toBe(false)
    })
  })
})
