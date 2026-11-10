import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { setupStrapi, cleanupStrapi } from './strapi'

const SITE_UID = 'plugin::micelio.site'
const ARTICLE_UID = 'api::article.article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const PASSWORD = 'Scope-admin-1'

interface FollowersService {
  recordFollower(strapi: unknown, input: { actorId: string }, site?: string): Promise<unknown>
  listFollowers(strapi: unknown, options?: { site?: string }): Promise<{ actorId: string }[]>
  countFollowers(strapi: unknown, options?: { site?: string }): Promise<number>
}

describe('The federation state of a site', () => {
  let siteA: string
  let siteB: string
  let article: string
  let superToken: string

  const followers = (): FollowersService => strapi.plugin('fediverse').service('followers')
  const server = () => strapi.server.httpServer
  const as = (token: string) => ({ Authorization: `Bearer ${token}` })

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    await setupStrapi()

    const first = (await strapi.db
      .query(SITE_UID)
      .findOne({ where: { isDefault: true }, select: ['documentId'] })) as { documentId: string }
    siteA = first.documentId
    const second = await strapi.documents(SITE_UID).create({
      data: {
        name: 'Site B',
        slug: 'site-b',
        hosts: ['b.example.test'],
        isDefault: false,
        defaultLocale: 'en',
        modules: {},
      } as never,
    })
    siteB = second.documentId

    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title: 'Scoped', slug: 'scoped', description: 'x' },
    })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    article = draft.documentId

    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    await strapi.service('admin::user').create({
      email: 'scope-super@example.test',
      password: PASSWORD,
      firstname: 'Scope',
      lastname: 'Super',
      isActive: true,
      roles: [superAdmin.id],
    })
    const login = await request(server())
      .post('/admin/login')
      .send({ email: 'scope-super@example.test', password: PASSWORD })
      .expect(200)
    superToken = login.body.data.token ?? login.body.data.accessToken
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  it('does not return a follower of site A in the followers collection, the stats or the page of site B', async () => {
    const actorId = 'https://remote.example/users/follower-of-a'
    await followers().recordFollower(strapi, { actorId }, siteA)
    await strapi
      .plugin('fediverse')
      .service('interactions')
      .recordInteraction(strapi, { type: 'like', actorId, articleDocumentId: article }, siteA)

    // The followers collection (what the actor's `followers` URI serves), and its counter.
    expect(
      (await followers().listFollowers(strapi, { site: siteA })).map((f) => f.actorId)
    ).toEqual([actorId])
    expect(await followers().listFollowers(strapi, { site: siteB })).toEqual([])
    expect(await followers().countFollowers(strapi, { site: siteA })).toBe(1)
    expect(await followers().countFollowers(strapi, { site: siteB })).toBe(0)

    // The stats: the content API names the site with `?site=<slug>`, and without it is the default.
    const stats = (site?: string) =>
      request(server())
        .get('/api/fediverse/articles/stats')
        .query({ documentIds: article, ...(site ? { site } : {}) })
        .expect(200)
    expect((await stats()).body[article]).toMatchObject({ likes: 1 })
    expect((await stats('site-b')).body[article]).toMatchObject({ likes: 0, boosts: 0 })
    const alone = await request(server())
      .get(`/api/fediverse/articles/${article}/stats`)
      .query({ site: 'site-b' })
      .expect(200)
    expect(alone.body).toMatchObject({ likes: 0 })
    await request(server())
      .get('/api/fediverse/articles/stats')
      .query({ documentIds: article, site: 'nope' })
      .expect(404)

    // The page: the same admin route, per site.
    const page = (site?: string) =>
      request(server())
        .get('/fediverse-panel/followers')
        .query(site ? { site } : {})
        .set(as(superToken))
    const own = await page().expect(200)
    expect(own.body.followers).toHaveLength(1)
    const other = await page('site-b').expect(200)
    expect(other.body.followers).toEqual([])
    await page('nope').expect(404)

    // A follower of another site cannot be blocked from this one.
    const row = (await strapi.db.query(FOLLOWER_UID).findOne({ where: { actorId } })) as {
      documentId: string
    }
    await request(server())
      .post(`/fediverse-panel/followers/${row.documentId}/block?site=site-b`)
      .set(as(superToken))
      .expect(404)
    expect(await strapi.db.query(FOLLOWER_UID).count({ where: { blocked: true } })).toBe(0)
  })

  it('counts the interactions of the site whose host the stats request was made to', async () => {
    const actorId = 'https://remote.example/users/fan-of-a'
    await strapi
      .plugin('fediverse')
      .service('interactions')
      .recordInteraction(strapi, { type: 'boost', actorId, articleDocumentId: article }, siteA)

    const stats = (host?: string) =>
      request(server())
        .get('/api/fediverse/articles/stats')
        .query({ documentIds: article })
        .set(host ? { Host: host } : {})
        .expect(200)
    expect((await stats()).body[article]).toMatchObject({ boosts: 1 })
    expect((await stats('b.example.test')).body[article]).toMatchObject({ boosts: 0 })
  })

  it('keeps a row the actor records on one site out of the other one', async () => {
    const actorId = 'https://remote.example/users/follower-of-both'
    await followers().recordFollower(strapi, { actorId }, siteA)
    await followers().recordFollower(strapi, { actorId }, siteB)

    expect(await strapi.db.query(FOLLOWER_UID).count({ where: { actorId } })).toBe(2)
    expect(await followers().countFollowers(strapi, { site: siteB })).toBe(1)
  })
})
