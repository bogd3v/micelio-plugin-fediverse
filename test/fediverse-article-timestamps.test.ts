import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { writeFediverseProfile } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import type { ActivityJson } from './helpers/api-types'
import type followers from '../server/src/services/followers'

// `published` and `updated` of a federated Article (#320, #321). GoToSocial refuses an object whose
// `updated` predates its `published`, and an `Update` whose `published` differs from the `Create`'s.

const ARTICLE_UID = 'api::article.article'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const ACTIVITY_JSON = 'application/activity+json'

const instant = (value: string | undefined) => new Date(value!).getTime()

describe('Fediverse federation (Article published and updated)', () => {
  let followersService: ReturnType<typeof followers>
  let remote: RemoteActor

  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  // The profile's `Update(Person)` goes to the same inbox as the article's `Update`.
  const forArticle = (documentId: string) => (a: ActivityJson) => a.object?.id?.endsWith(documentId)
  const uniqueTitle = () => `Timestamps ${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  async function createArticle() {
    const title = uniqueTitle()
    return strapi.documents(ARTICLE_UID).create({
      data: {
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: 'Excerpt.',
      },
    })
  }

  async function served(documentId: string): Promise<ActivityJson> {
    const res = await fetch(`http://${serverHost()}/fediverse/articles/${documentId}`, {
      headers: { accept: ACTIVITY_JSON },
    })
    return (await res.json()) as ActivityJson
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()
    followersService = strapi.plugin('fediverse').service('followers')

    // The default is a Note (#305); this suite covers the Article shape, so it asks for it.
    await writeFediverseProfile({ objectType: 'article' })
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'timestamp-reader' })
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
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })

  it('never serves an `updated` earlier than `published`', async () => {
    const draft = await createArticle()
    // Strapi keeps the draft's `updatedAt` when it publishes: the draft is older than the publish.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    await waitUntil(() => deliveriesOf('Create').length === 1)

    const create = deliveriesOf('Create')[0].object!
    const object = await served(draft.documentId)
    for (const article of [create, object]) {
      expect(article.published).toBeDefined()
      if (article.updated)
        expect(instant(article.updated)).toBeGreaterThanOrEqual(instant(article.published))
    }
  })

  it('keeps `published` through an edit: the Create, the Update and the served object agree', async () => {
    const draft = await createArticle()
    const id = draft.documentId
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    await waitUntil(() => deliveriesOf('Create').length === 1)
    const firstPublished = deliveriesOf('Create')[0].object!.published

    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await strapi.documents(ARTICLE_UID).update({ documentId: id, data: { title: 'Edited' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    const update = (await waitUntil(() => deliveriesOf('Update').find(forArticle(id)))).object!
    const object = await served(id)
    expect(update.name).toBe('Edited')
    expect(update.published).toBe(firstPublished)
    expect(object.published).toBe(firstPublished)
    // The edit is what `updated` says, and it is after `published`.
    expect(instant(update.updated)).toBeGreaterThan(instant(firstPublished))
    expect(instant(object.updated)).toBeGreaterThan(instant(firstPublished))
  })

  it('reads the article’s Update even when a profile Update(Person) arrived first', async () => {
    const draft = await createArticle()
    const id = draft.documentId
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    await waitUntil(() => deliveriesOf('Create').find(forArticle(id)))

    await writeFediverseProfile({ objectType: 'article', displayName: `Renamed ${Date.now()}` })
    await waitUntil(() => deliveriesOf('Update').length === 1)
    expect(deliveriesOf('Update')[0].object?.type).toBe('Person')

    await strapi.documents(ARTICLE_UID).update({ documentId: id, data: { title: 'Edited' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    const update = (await waitUntil(() => deliveriesOf('Update').find(forArticle(id)))).object!
    expect(update.name).toBe('Edited')
  })

  it('starts over when the article is retracted and published again', async () => {
    const draft = await createArticle()
    const id = draft.documentId
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    await waitUntil(() => deliveriesOf('Create').length === 1)
    const first = deliveriesOf('Create')[0].object!.published

    await strapi.documents(ARTICLE_UID).unpublish({ documentId: id })
    await waitUntil(() => deliveriesOf('Delete').length === 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    await waitUntil(() => deliveriesOf('Create').length === 2)

    const second = deliveriesOf('Create')[1].object!.published
    expect(instant(second)).toBeGreaterThan(instant(first))
    expect((await served(id)).published).toBe(second)
  })

  it('falls back to the publish time for a row with no createSentAt', async () => {
    const draft = await createArticle()
    const id = draft.documentId
    await strapi.documents(ARTICLE_UID).publish({ documentId: id })
    await waitUntil(() => deliveriesOf('Create').length === 1)
    await strapi.db
      .query(ROW_UID)
      .updateMany({ where: { articleDocumentId: id }, data: { createSentAt: null } })

    const published = (await strapi
      .documents(ARTICLE_UID)
      .findOne({ documentId: id, status: 'published' }))!.publishedAt as string
    expect(instant((await served(id)).published)).toBe(instant(published))
  })
})
