import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'

const ARTICLE_UID = 'api::article.article'
const INTERACTION_UID = 'plugin::fediverse.interaction'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

describe('Fediverse federation (Phase 4: likes and boosts)', () => {
  let host: string
  let inboxUrl: string
  let remotes: RemoteActor[] = []
  let activityCounter = 0

  const articleUri = (documentId: string) => `http://${host}/fediverse/articles/${documentId}`
  const settle = (ms = 500) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const send = (remote: RemoteActor, activity: object) =>
    remote.postSignedActivity(inboxUrl, activity)

  async function publishedArticle() {
    const title = `Liked article ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title, slug: slugify(title), description: 'Excerpt.' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    return draft
  }

  async function newRemote() {
    const remote = await createRemoteActor({ preferredUsername: `fan${remotes.length}` })
    remotes.push(remote)
    return remote
  }

  function activity(remote: RemoteActor, type: string, object: unknown, extra: object = {}) {
    activityCounter += 1
    return {
      '@context': AS_CONTEXT,
      id: `${remote.actorUrl}/activities/${type}-${activityCounter}`,
      type,
      actor: remote.actorUrl,
      object,
      ...extra,
    }
  }

  async function stats(documentId: string) {
    const res = await request(strapi.server.httpServer).get(
      `/api/fediverse/articles/${documentId}/stats`
    )
    return { status: res.status, body: res.body }
  }

  const interactionsOf = (articleDocumentId: string) =>
    strapi.db.query(INTERACTION_UID).findMany({ where: { articleDocumentId } })

  async function expectCounts(documentId: string, expected: { likes: number; boosts: number }) {
    await waitUntil(async () => {
      const { body } = await stats(documentId)
      return body.likes === expected.likes && body.boosts === expected.boosts
    })
  }

  beforeAll(async () => {
    // Enable the fediverse plugin before Strapi boots (the plugin reads it when it loads, `server/src/utils/federation-enabled.ts`).
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()
    host = serverHost()
    inboxUrl = `http://${host}/fediverse/user/devbog/inbox`
  })

  afterEach(async () => {
    await Promise.all(remotes.map((remote) => remote.close()))
    remotes = []
    for (const uid of ['plugin::fediverse.follower', INTERACTION_UID]) {
      const rows = await strapi.db.query(uid).findMany()
      for (const row of rows) {
        await strapi.db.query(uid).delete({ where: { documentId: row.documentId } })
      }
    }
  })

  afterAll(async () => {
    await settle(300)
    await cleanupStrapi()
  })

  describe('Like and Announce', () => {
    it('counts a Like and an Announce of an article, recording who sent them', async () => {
      const article = await publishedArticle()
      const remote = await newRemote()

      expect(
        (await send(remote, activity(remote, 'Like', articleUri(article.documentId)))).ok
      ).toBe(true)
      expect(
        (
          await send(
            remote,
            activity(remote, 'Announce', articleUri(article.documentId), {
              to: 'https://www.w3.org/ns/activitystreams#Public',
            })
          )
        ).ok
      ).toBe(true)

      await expectCounts(article.documentId, { likes: 1, boosts: 1 })
      const rows = await interactionsOf(article.documentId)
      expect(rows.map((r) => r.type).sort()).toEqual(['boost', 'like'])
      expect(rows[0].actorId).toBe(remote.actorUrl)
      expect(rows[0].handle).toMatch(/^@fan\d+@/)
    })

    it('counts a Like addressed to the frontend url of the article', async () => {
      const article = await publishedArticle()
      const remote = await newRemote()

      await send(remote, activity(remote, 'Like', `https://blog.example.test/blog/${article.slug}`))

      await expectCounts(article.documentId, { likes: 1, boosts: 0 })
    })

    it('counts one like per actor no matter how often it is delivered', async () => {
      const article = await publishedArticle()
      const remote = await newRemote()

      for (let i = 0; i < 3; i += 1) {
        await send(remote, activity(remote, 'Like', articleUri(article.documentId)))
      }
      await expectCounts(article.documentId, { likes: 1, boosts: 0 })
      await settle()
      expect(await interactionsOf(article.documentId)).toHaveLength(1)

      const other = await newRemote()
      await send(other, activity(other, 'Like', articleUri(article.documentId)))
      await expectCounts(article.documentId, { likes: 2, boosts: 0 })
    })

    it('stays consistent when the same interaction is recorded concurrently', async () => {
      const article = await publishedArticle()
      const input = {
        type: 'like',
        actorId: 'https://race.example/users/racer',
        articleDocumentId: article.documentId,
      }
      const service = strapi.plugin('fediverse').service('interactions')

      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.recordInteraction(strapi, input))
      )

      // What must hold is one surviving row; on Postgres two writers can each
      // report `created` when one later removes the other's duplicate.
      expect(results).toContain('created')
      expect(await interactionsOf(article.documentId)).toHaveLength(1)
    })

    it.each([
      [
        'something that is not one of our articles',
        async () => 'https://elsewhere.example/notes/9',
      ],
      [
        'an article that is not published',
        async () => {
          const title = `Draft ${Date.now()}`
          const draft = await strapi
            .documents(ARTICLE_UID)
            .create({ data: { title, slug: slugify(title) } })
          return articleUri(draft.documentId)
        },
      ],
    ])('ignores a Like of %s', async (_label, buildObject) => {
      const remote = await newRemote()

      expect((await send(remote, activity(remote, 'Like', await buildObject()))).ok).toBe(true)
      await settle()

      expect(await strapi.db.query(INTERACTION_UID).count()).toBe(0)
    })

    it('ignores interactions from blocked actors, including ones made before the block', async () => {
      const article = await publishedArticle()
      const remote = await newRemote()
      const followers = strapi.plugin('fediverse').service('followers')

      await send(remote, activity(remote, 'Like', articleUri(article.documentId)))
      await expectCounts(article.documentId, { likes: 1, boosts: 0 })

      await followers.recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
      const row = await strapi.db
        .query('plugin::fediverse.follower')
        .findOne({ where: { actorId: remote.actorUrl } })
      await strapi.db
        .query('plugin::fediverse.follower')
        .update({ where: { documentId: row.documentId }, data: { blocked: true } })

      // The earlier like no longer counts, and new ones are dropped.
      await expectCounts(article.documentId, { likes: 0, boosts: 0 })
      await send(remote, activity(remote, 'Announce', articleUri(article.documentId)))
      await settle()
      expect(await stats(article.documentId)).toMatchObject({ body: { likes: 0, boosts: 0 } })
    })
  })

  describe('Undo', () => {
    it.each([
      ['Like', 'likes'],
      ['Announce', 'boosts'],
    ])('withdraws an %s', async (type, field) => {
      const article = await publishedArticle()
      const remote = await newRemote()
      const original = activity(remote, type, articleUri(article.documentId))

      await send(remote, original)
      await expectCounts(article.documentId, {
        likes: type === 'Like' ? 1 : 0,
        boosts: type === 'Announce' ? 1 : 0,
      })

      expect((await send(remote, activity(remote, 'Undo', original))).ok).toBe(true)

      await expectCounts(article.documentId, { likes: 0, boosts: 0 })
      expect((await stats(article.documentId)).body[field]).toBe(0)
    })

    it("does not let one account withdraw another account's like on the same server", async () => {
      const article = await publishedArticle()
      const attacker = await newRemote()
      // Same origin as the attacker: Fedify trusts objects embedded from the
      // sender's own origin, so only our actor check stands in the way.
      const victimId = `${new URL(attacker.actorUrl).origin}/users/victim`
      await strapi.plugin('fediverse').service('interactions').recordInteraction(strapi, {
        type: 'like',
        actorId: victimId,
        articleDocumentId: article.documentId,
      })
      await expectCounts(article.documentId, { likes: 1, boosts: 0 })

      // Signed by the attacker, but embedding the victim's Like.
      const victimLike = {
        '@context': AS_CONTEXT,
        id: `${victimId}/likes/1`,
        type: 'Like',
        actor: victimId,
        object: articleUri(article.documentId),
      }
      expect((await send(attacker, activity(attacker, 'Undo', victimLike))).ok).toBe(true)
      await settle()

      expect((await stats(article.documentId)).body.likes).toBe(1)
    })
  })

  describe('stats endpoint', () => {
    it('is public and exposes only aggregate counts', async () => {
      const article = await publishedArticle()
      const remote = await newRemote()
      await send(remote, activity(remote, 'Like', articleUri(article.documentId)))
      await expectCounts(article.documentId, { likes: 1, boosts: 0 })

      const res = await request(strapi.server.httpServer)
        .get(`/api/fediverse/articles/${article.documentId}/stats`)
        .expect(200)

      expect(res.body).toEqual({ likes: 1, boosts: 0 })
    })

    it('returns 404 for unknown and unpublished articles', async () => {
      const title = `Unpublished ${Date.now()}`
      const draft = await strapi
        .documents(ARTICLE_UID)
        .create({ data: { title, slug: slugify(title) } })

      expect((await stats(draft.documentId)).status).toBe(404)
      expect((await stats('does-not-exist')).status).toBe(404)
    })
  })
})
