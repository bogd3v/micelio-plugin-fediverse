import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { setupStrapi, cleanupStrapi } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { writeFediverseProfile } from './helpers/fediverse-profile'

const ARTICLE_UID = 'api::article.article'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const SITE_UID = 'plugin::micelio.site'
const PASSWORD = 'Editorial-admin-1'
/** Long enough for a second, wrong send to arrive: the first one is awaited with `waitUntil`. */
const SETTLE_MS = 600

/**
 * The articles of these tests belong to a second site, with its own follower, and the default site
 * has a follower of its own. `strapi.eventHub` knows no site and federates for the default one, so
 * a send that reaches the follower of the second site, and a row keyed by it, can only come from
 * the payload of the core's hooks.
 */
describe('Fediverse federation (afterPublish and afterUnpublish of the core)', () => {
  let remote: RemoteActor
  let defaultRemote: RemoteActor
  let token: string
  let siteB: string
  let defaultSite: string

  const server = () => strapi.server.httpServer
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  const rowsOf = (articleDocumentId: string) =>
    strapi.db.query(ROW_UID).findMany({ where: { articleDocumentId }, populate: ['site'] })
  const siteOfRow = (row: unknown) => (row as { site: { documentId: string } }).site.documentId
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))

  /** Moves the entry through `POST /micelio/transitions`, as the admin panel does. */
  async function transition(documentId: string, to: string, expected = 200, locale?: string) {
    return request(server())
      .post('/micelio/transitions')
      .set('Authorization', `Bearer ${token}`)
      .send({ uid: ARTICLE_UID, documentId, to, locale })
      .expect((r) => {
        if (r.status !== expected) throw new Error(`${r.status}: ${JSON.stringify(r.body)}`)
      })
  }

  /** A draft article of the type made with `withEditorial`, in the second site, moved to `in_review`. */
  async function articleInReview(): Promise<string> {
    const title = `Editorial article ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: {
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: 'x',
        editorial: { state: 'draft' },
        // `withSiteScope` makes the site required.
        site: siteB,
      } as never,
    })
    await transition(draft.documentId, 'in_review')
    return draft.documentId
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi({ editorialArticle: true })
    await writeFediverseProfile({ objectType: 'article' })

    defaultSite = (
      (await strapi.db
        .query(SITE_UID)
        .findOne({ where: { isDefault: true }, select: ['documentId'] })) as { documentId: string }
    ).documentId
    siteB = (
      await strapi.documents(SITE_UID).create({
        data: {
          name: 'Site B',
          slug: 'site-b',
          hosts: ['b.example.test'],
          isDefault: false,
          defaultLocale: 'en',
          modules: {},
        } as never,
      })
    ).documentId

    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    await strapi.service('admin::user').create({
      email: 'editorial-super@example.test',
      password: PASSWORD,
      firstname: 'Editorial',
      lastname: 'Super',
      isActive: true,
      roles: [superAdmin.id],
    })
    const res = await request(server())
      .post('/admin/login')
      .send({ email: 'editorial-super@example.test', password: PASSWORD })
      .expect(200)
    token = res.body.data.token ?? res.body.data.accessToken
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader-b' })
    defaultRemote = await createRemoteActor({ preferredUsername: 'reader-default' })
    const followers = strapi.plugin('fediverse').service('followers')
    await followers.recordFollower(
      strapi,
      { actorId: remote.actorUrl, inbox: remote.inboxUrl },
      siteB
    )
    await followers.recordFollower(strapi, {
      actorId: defaultRemote.actorUrl,
      inbox: defaultRemote.inboxUrl,
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await remote.close()
    await defaultRemote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })

  it('boots the article with the editorial component', () => {
    const options = strapi.contentType(ARTICLE_UID).pluginOptions as {
      micelio?: { editorial?: boolean }
    }
    expect(options.micelio?.editorial).toBe(true)
  })

  it('sends one Create(Article) when an article moves from in_review to published through POST /micelio/transitions', async () => {
    const documentId = await articleInReview()
    expect(deliveriesOf('Create')).toHaveLength(0)

    await transition(documentId, 'published')

    const create = await waitUntil(() => deliveriesOf('Create')[0])
    expect((create.object as { type: string }).type).toBe('Article')
    await settle()
    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(remote.inboxDeliveries).toHaveLength(1)
    // Keyed by the site of the payload: the follower of the default site hears nothing.
    expect(defaultRemote.inboxDeliveries).toHaveLength(0)

    const rows = await rowsOf(documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'created', lastActivityType: 'Create' })
    expect(siteOfRow(rows[0])).toBe(siteB)
  })

  it('sends one Update when a published article is published again', async () => {
    const documentId = await articleInReview()
    await transition(documentId, 'published')
    await waitUntil(() => deliveriesOf('Create').length === 1)

    await transition(documentId, 'published')

    const update = await waitUntil(() => deliveriesOf('Update')[0])
    expect((update.object as { type: string }).type).toBe('Article')
    await settle()
    expect(deliveriesOf('Update')).toHaveLength(1)
    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(defaultRemote.inboxDeliveries).toHaveLength(0)
  })

  it('sends one Delete when a published article moves back to draft', async () => {
    const documentId = await articleInReview()
    await transition(documentId, 'published')
    await waitUntil(() => deliveriesOf('Create').length === 1)

    await transition(documentId, 'draft')

    await waitUntil(() => deliveriesOf('Delete')[0])
    await settle()
    expect(deliveriesOf('Delete')).toHaveLength(1)
    expect(defaultRemote.inboxDeliveries).toHaveLength(0)
    const rows = await rowsOf(documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'deleted', lastActivityType: 'Delete' })
    expect(siteOfRow(rows[0])).toBe(siteB)
  })

  it('sends one Delete when a published article of a second site is deleted', async () => {
    const documentId = await articleInReview()
    await transition(documentId, 'published')
    await waitUntil(() => deliveriesOf('Create').length === 1)

    // Strapi emits `entry.delete` once per stored version (the draft and the published one).
    await strapi.documents(ARTICLE_UID).delete({ documentId })

    await waitUntil(() => deliveriesOf('Delete')[0])
    await settle()
    expect(deliveriesOf('Delete')).toHaveLength(1)
    expect(defaultRemote.inboxDeliveries).toHaveLength(0)
    const rows = await rowsOf(documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'deleted', lastActivityType: 'Delete' })
    expect(siteOfRow(rows[0])).toBe(siteB)
  })

  it('does not send an article of a type with editorial twice', async () => {
    const documentId = await articleInReview()

    // The transition publishes with the Document Service too, which emits `entry.publish`
    // on the event hub: only the hook may send.
    const events: string[] = []
    const off = strapi.eventHub.on('entry.publish', ((payload: { uid?: string }) => {
      if (payload.uid === ARTICLE_UID) events.push('entry.publish')
    }) as never)
    await transition(documentId, 'published')
    await waitUntil(() => events.length >= 1)
    await waitUntil(() => deliveriesOf('Create').length >= 1)
    await settle()
    off()
    expect(events).toHaveLength(1)

    // The event the Document Service emits for it again, and for its unpublish: ignored for a
    // type with editorial. The event hub would federate it for the default site.
    for (const action of ['entry.publish', 'entry.unpublish']) {
      await strapi.eventHub.emit(action, {
        uid: ARTICLE_UID,
        entry: { documentId, locale: 'en' },
      } as never)
    }
    await settle()

    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(0)
    expect(deliveriesOf('Delete')).toHaveLength(0)
    expect(defaultRemote.inboxDeliveries).toHaveLength(0)
    const rows = await rowsOf(documentId)
    expect(rows).toHaveLength(1)
    expect(siteOfRow(rows[0])).toBe(siteB)

    // And the unpublish of the transition sends one Delete, not one from each trigger.
    await transition(documentId, 'draft')
    await waitUntil(() => deliveriesOf('Delete').length >= 1)
    await settle()
    expect(deliveriesOf('Delete')).toHaveLength(1)
    expect(defaultRemote.inboxDeliveries).toHaveLength(0)
  })

  it('leaves one federated-article row after two publishes of the same documentId and locale', async () => {
    const documentId = await articleInReview()
    await transition(documentId, 'published')
    await transition(documentId, 'published')

    await waitUntil(() => deliveriesOf('Update').length >= 1)
    await settle()

    const rows = await rowsOf(documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'updated', lastActivityType: 'Update' })
    expect(siteOfRow(rows[0])).toBe(siteB)
    expect(await rowsOf(documentId)).not.toContainEqual(
      expect.objectContaining({ site: expect.objectContaining({ documentId: defaultSite }) })
    )
    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(1)
  })

  it('sends nothing for a version in a locale other than the default', async () => {
    const locales = strapi.plugin('i18n').service('locales')
    if (!(await locales.findByCode('es')))
      await locales.create({ code: 'es', name: 'Spanish (es)' })
    // The Spanish version of a document that exists in the default locale.
    const title = `Locale article ${Date.now()}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: {
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: 'x',
        editorial: { state: 'draft' },
        site: siteB,
      } as never,
    })
    await strapi.documents(ARTICLE_UID).update({
      documentId: draft.documentId,
      locale: 'es',
      data: { title: `Artículo ${Date.now()}`, description: 'x', editorial: { state: 'draft' } },
    } as never)
    const warnings = vi.spyOn(strapi.log, 'warn').mockImplementation((() => {}) as never)
    await transition(draft.documentId, 'in_review', 200, 'es')
    await transition(draft.documentId, 'published', 200, 'es')
    await settle()

    // The handler returns before it looks for a default-locale version to federate.
    expect(warnings.mock.calls.filter(([m]) => String(m).includes('not federating'))).toEqual([])
    expect(remote.inboxDeliveries).toHaveLength(0)
    expect(await rowsOf(draft.documentId)).toHaveLength(0)
  })

  it('logs a handler failure and keeps the publish', async () => {
    const documentId = await articleInReview()
    const errors = vi.spyOn(strapi.log, 'error').mockImplementation((() => {}) as never)
    const query = strapi.db.query.bind(strapi.db)
    vi.spyOn(strapi.db, 'query').mockImplementation(((uid: string) => {
      if (uid === ROW_UID) throw new Error('the row store is down')
      return query(uid as never)
    }) as never)

    const res = await transition(documentId, 'published')
    vi.restoreAllMocks()

    expect(res.body.data).toMatchObject({ documentId, from: 'in_review', to: 'published' })
    const published = await strapi.documents(ARTICLE_UID).findOne({
      documentId,
      status: 'published',
    })
    expect(published).not.toBeNull()
    // The line of the hook handler, not the event hub's: the cause is logged on the server.
    const calls = errors.mock.calls as unknown as Array<[string, { error: Error }]>
    const logged = calls.filter(([message]) =>
      String(message).includes('[fediverse] afterPublish federation failed')
    )
    expect(logged).toHaveLength(1)
    expect(logged[0][1].error.message).toContain('the row store is down')
    expect(deliveriesOf('Create')).toHaveLength(0)
  })
})
