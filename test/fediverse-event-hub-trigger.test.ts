import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { setupStrapi, cleanupStrapi } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { writeFediverseProfile } from './helpers/fediverse-profile'

const ARTICLE_UID = 'api::article.article'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'

describe('Fediverse federation (strapi.eventHub, a type without editorial)', () => {
  let remote: RemoteActor

  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()
    await writeFediverseProfile({ objectType: 'article' })
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

  it('sends the same activities through entry.publish for a type without editorial', async () => {
    const options = strapi.contentType(ARTICLE_UID).pluginOptions as {
      micelio?: { editorial?: boolean }
    }
    expect(options?.micelio?.editorial).toBeUndefined()

    const title = `Event hub article ${Date.now()}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: 'x' },
    })
    const target = { documentId: draft.documentId }

    await strapi.documents(ARTICLE_UID).publish(target)
    const create = await waitUntil(() => deliveriesOf('Create')[0])
    expect((create.object as { type: string }).type).toBe('Article')

    await strapi.documents(ARTICLE_UID).publish(target)
    const update = await waitUntil(() => deliveriesOf('Update')[0])
    expect((update.object as { type: string }).type).toBe('Article')

    await strapi.documents(ARTICLE_UID).unpublish(target)
    await waitUntil(() => deliveriesOf('Delete')[0])

    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(1)
    expect(deliveriesOf('Delete')).toHaveLength(1)
  })

  it('ignores the hooks of the core for a type without editorial', async () => {
    const title = `Hook-less article ${Date.now()}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: 'x' },
    })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    await waitUntil(() => deliveriesOf('Create')[0])

    // The core fires these only for a type made with `withEditorial`; the plugin does not rely on it.
    const hooks = strapi.plugin('micelio').service('hooks')
    await hooks.runAfter('afterPublish', {
      site: null,
      type: ARTICLE_UID,
      documentId: draft.documentId,
      locale: 'en',
      actor: { kind: 'system' },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 600))

    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(0)
  })
})
