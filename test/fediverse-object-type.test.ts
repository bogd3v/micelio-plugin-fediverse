import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { writeFediverseProfile } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import type { ActivityJson } from './helpers/api-types'
import type followers from '../server/src/services/followers'
import { waitUntil } from './helpers/wait-until'

const ACTIVITY_JSON = 'application/activity+json'
const ARTICLE_UID = 'api::article.article'

type ObjectType = 'article' | 'note'
const TYPES: Array<[ObjectType, 'Article' | 'Note']> = [
  ['article', 'Article'],
  ['note', 'Note'],
]

describe('Fediverse federation (#305: object shape, Article or Note)', () => {
  let host: string
  let remote: RemoteActor
  let followersService: ReturnType<typeof followers>

  const settle = (ms = 600) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  const forArticle = (documentId: string) => (a: ActivityJson) => a.object?.id?.endsWith(documentId)

  /** Sets `fediverse.objectType` on the default site; `null` leaves the component without one. */
  async function setObjectType(objectType: ObjectType | null) {
    await writeFediverseProfile(objectType ? { objectType } : null)
  }

  async function createPublished(extra: Record<string, unknown> = {}) {
    const title = `Shape ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: {
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: 'An excerpt with <markup> & more.',
        ...extra,
      } as never,
    })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    return draft
  }

  async function getJson(path: string) {
    const res = await fetch(`http://${host}${path}`, { headers: { accept: ACTIVITY_JSON } })
    return { status: res.status, body: (res.ok ? await res.json() : {}) as ActivityJson }
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()
    host = serverHost()
    followersService = strapi.plugin('fediverse').service('followers')
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader' })
    await followersService.recordFollower(strapi, {
      actorId: remote.actorUrl,
      inbox: remote.inboxUrl,
    })
  })

  afterEach(async () => {
    await setObjectType(null)
    await settle(300)
    await remote.close()
    const rows = await strapi.db.query('plugin::fediverse.follower').findMany()
    for (const row of rows) {
      await strapi.db
        .query('plugin::fediverse.follower')
        .delete({ where: { documentId: row.documentId } })
    }
  })

  afterAll(async () => {
    await settle(500)
    await cleanupStrapi()
  })

  describe.each(TYPES)('objectType %s', (objectType, apType) => {
    beforeEach(async () => {
      await setObjectType(objectType)
    })

    it(`serves the article as a ${apType} with the same body`, async () => {
      const draft = await createPublished()

      const { status, body } = await getJson(`/fediverse/articles/${draft.documentId}`)

      expect(status).toBe(200)
      expect(body.type).toBe(apType)
      expect(body.id).toBe(`http://${host}/fediverse/articles/${draft.documentId}`)
      expect(body.url).toBe(`https://blog.example.test/blog/${draft.slug}`)
      // The Article's `name` is the title; repeating it in the body made GoToSocial show it twice.
      if (objectType === 'note')
        expect(body.content).toContain(`<p><strong>${draft.title}</strong></p>`)
      else expect(body.content).not.toContain(draft.title)
      expect(body.content).toContain('An excerpt with &lt;markup&gt; &amp; more.')
      expect(body.content).toContain(`https://blog.example.test/blog/${draft.slug}`)
      // GoToSocial reads `name` as a content warning, so a Note has none.
      if (objectType === 'note') expect(body.name).toBeUndefined()
      else expect(body.name).toBe(draft.title)
    })

    it(`keeps the image and the cover credit line on a ${apType}`, async () => {
      const cover = await strapi.db.query('plugin::upload.file').create({
        data: {
          name: 'cover.png',
          hash: `cover_${objectType}`,
          ext: '.png',
          mime: 'image/png',
          size: 1,
          url: `/uploads/cover-${objectType}.png`,
          provider: 'local',
          alternativeText: 'A cover',
        },
      })
      const draft = await createPublished({
        cover: cover.id,
        coverCredit: {
          kind: 'photo',
          author: 'Ada',
          sourceUrl: 'https://photos.example.test/ada',
          license: 'cc-by-4.0',
        },
      })

      const { body } = await getJson(`/fediverse/articles/${draft.documentId}`)

      expect(body.image).toMatchObject({
        url: `http://${host}/uploads/cover-${objectType}.png`,
        mediaType: 'image/png',
        name: 'A cover',
      })
      // GoToSocial ignores `image`: the cover must also be an attachment.
      expect(body.attachment).toMatchObject({
        type: 'Image',
        url: `http://${host}/uploads/cover-${objectType}.png`,
        mediaType: 'image/png',
        name: 'A cover',
      })
      expect(body.content).toContain('Ada')
      expect(body.content).toContain('CC BY')
    })

    it(`lists the outbox Create with a ${apType}`, async () => {
      const draft = await createPublished()

      const outbox = await getJson('/fediverse/user/devbog/outbox?cursor=0')
      const create = (outbox.body.orderedItems as ActivityJson[]).find(forArticle(draft.documentId))

      expect(create?.type).toBe('Create')
      expect(create?.object?.type).toBe(apType)
    })

    it(`fans out Create and Update with a ${apType}`, async () => {
      const draft = await createPublished()
      const create = await waitUntil(() =>
        deliveriesOf('Create').find(forArticle(draft.documentId))
      )
      expect(create.object?.type).toBe(apType)

      await strapi
        .documents(ARTICLE_UID)
        .update({ documentId: draft.documentId, data: { title: `${draft.title} edited` } })
      await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
      const update = await waitUntil(() =>
        deliveriesOf('Update').find(forArticle(draft.documentId))
      )
      expect(update.object?.type).toBe(apType)
      expect(update.object?.id).toBe(create.object?.id)
    })
  })

  it('the object type comes from the default site', async () => {
    await setObjectType('note')
    const asNote = await createPublished()
    expect((await getJson(`/fediverse/articles/${asNote.documentId}`)).body.type).toBe('Note')

    await setObjectType('article')
    const asArticle = await createPublished()
    expect((await getJson(`/fediverse/articles/${asArticle.documentId}`)).body.type).toBe('Article')
  })

  it('sends a Note when the setting is empty', async () => {
    await setObjectType(null)
    const draft = await createPublished()

    const { body } = await getJson(`/fediverse/articles/${draft.documentId}`)

    expect(body.type).toBe('Note')
  })

  it('keeps the id and the url of an article when the type changes', async () => {
    await setObjectType('article')
    const draft = await createPublished()
    const asArticle = (await getJson(`/fediverse/articles/${draft.documentId}`)).body

    await setObjectType('note')
    const asNote = (await getJson(`/fediverse/articles/${draft.documentId}`)).body

    expect(asArticle.type).toBe('Article')
    expect(asNote.type).toBe('Note')
    expect(asNote.id).toBe(asArticle.id)
    expect(asNote.url).toBe(asArticle.url)
    expect(asNote.published).toBe(asArticle.published)
  })

  it('sends no activity when the setting changes', async () => {
    await setObjectType('article')
    const draft = await createPublished()
    await waitUntil(() => deliveriesOf('Create').find(forArticle(draft.documentId)))
    // The first save of the settings may send an Update(Person); let it land before counting.
    await settle()
    const before = remote.inboxDeliveries.length

    await setObjectType('note')
    await settle(800)
    await setObjectType('article')
    await settle(800)

    expect(remote.inboxDeliveries).toHaveLength(before)
  })
})
