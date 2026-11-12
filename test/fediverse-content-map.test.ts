import request from 'supertest'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { writeFediverseProfile } from './helpers/fediverse-profile'
import type { ActivityJson } from './helpers/api-types'
import { waitUntil } from './helpers/wait-until'

const ARTICLE_UID = 'api::article.article'
const SITE_UID = 'plugin::micelio.site'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const COMMENT_UID = 'plugin::comments.comment'
const ACTIVITY_JSON = 'application/activity+json'
/** Long enough for a wrong send to arrive: the right ones are awaited with `waitUntil`. */
const SETTLE_MS = 600

type Json = ActivityJson & { contentMap?: Record<string, string>; nameMap?: Record<string, string> }
const objectOf = (activity: ActivityJson) => activity.object as Json

const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const settle = (ms = SETTLE_MS) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function ensureLocale(code: string, name: string) {
  const locales = strapi.plugin('i18n').service('locales')
  if (!(await locales.findByCode(code))) await locales.create({ code, name })
}

/** The Strapi that every suite below boots: the article's type with or without `withEditorial`. */
function bootWith(editorialArticle: boolean, extra: () => Promise<void> = async () => {}) {
  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi({ editorialArticle })
    await writeFediverseProfile({ objectType: 'article' })
    await ensureLocale('es', 'Spanish (es)')
    await extra()
  })
  afterAll(async () => {
    await settle(500)
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })
}

/** A bilingual article: `en` (the default locale) and `es` drafts, nothing published yet. */
async function bilingualDraft(site?: string) {
  const title = `Mapped article ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const draft = await strapi.documents(ARTICLE_UID).create({
    data: {
      title,
      slug: slugify(title),
      description: 'English excerpt.',
      ...(site ? { editorial: { state: 'draft' }, site } : {}),
    } as never,
  })
  await strapi.documents(ARTICLE_UID).update({
    documentId: draft.documentId,
    locale: 'es',
    data: {
      title: `Artículo ${title}`,
      slug: `articulo-${slugify(title)}`,
      description: 'Resumen en español.',
    } as never,
  })
  return { documentId: draft.documentId, title, slug: slugify(title) }
}

describe('Fediverse localized articles (contentMap, event hub)', () => {
  let remote: RemoteActor
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  const publish = (documentId: string, locale: string) =>
    strapi.documents(ARTICLE_UID).publish({ documentId, locale })
  const unpublish = (documentId: string, locale: string) =>
    strapi.documents(ARTICLE_UID).unpublish({ documentId, locale })

  let adminToken: string
  bootWith(false, async () => {
    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    await strapi.service('admin::user').create({
      email: 'map-super@example.test',
      password: 'Content-map-1',
      firstname: 'Map',
      lastname: 'Super',
      isActive: true,
      roles: [superAdmin.id],
    })
    const res = await request(strapi.server.httpServer)
      .post('/admin/login')
      .send({ email: 'map-super@example.test', password: 'Content-map-1' })
      .expect(200)
    adminToken = res.body.data.token ?? res.body.data.accessToken
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader-map' })
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterEach(async () => {
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  it('an article with two published locales federates one object whose contentMap has both, default locale first', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'es')
    await publish(article.documentId, 'en')
    const create = await waitUntil(() => deliveriesOf('Create')[0])
    const object = objectOf(create)

    expect(new URL(object.id!).pathname).toBe(`/fediverse/articles/${article.documentId}`)
    expect(object.url).toBe(`https://blog.example.test/blog/${article.slug}`)
    expect(object.name).toBe(article.title)
    expect(Object.keys(object.contentMap ?? {})).toEqual(['en', 'es'])
    expect(object.contentMap?.en).toBe(object.content)
    expect(object.contentMap?.en).toContain(`https://blog.example.test/blog/${article.slug}`)
    expect(object.contentMap?.es).toContain(
      `https://blog.example.test/es/blog/articulo-${article.slug}`
    )
    expect(object.contentMap?.es).toContain('Resumen en español.')
    expect(Object.keys(object.nameMap ?? {})).toEqual(['en', 'es'])
    expect(object.nameMap?.es).toBe(`Artículo ${article.title}`)

    const served = await fetch(`http://${serverHost()}/fediverse/articles/${article.documentId}`, {
      headers: { accept: ACTIVITY_JSON },
    })
    expect(((await served.json()) as Json).contentMap).toEqual(object.contentMap)
  })

  it('publishing the second locale sends an Update, not a second Create', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    const create = await waitUntil(() => deliveriesOf('Create')[0])
    expect(Object.keys(objectOf(create).contentMap ?? {})).toEqual(['en'])

    await publish(article.documentId, 'es')
    const update = await waitUntil(() => deliveriesOf('Update')[0])

    expect(Object.keys(objectOf(update).contentMap ?? {})).toEqual(['en', 'es'])
    expect(objectOf(update).id).toBe(objectOf(create).id)
    // The default locale's row did not move: the translation's publish is what `updated` shows.
    expect(objectOf(update).updated).toBeDefined()
    expect(Date.parse(objectOf(update).updated!)).toBeGreaterThan(
      Date.parse(objectOf(create).updated ?? objectOf(create).published!)
    )
    await settle()
    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(1)
    const rows = await strapi.db.query(ROW_UID).findMany({
      where: { articleDocumentId: article.documentId },
    })
    expect(rows).toHaveLength(1)
  })

  it('a translation published before the default locale sends nothing, and is in the map of the Create', async () => {
    const article = await bilingualDraft()
    const warn = vi.spyOn(strapi.log, 'warn')
    await publish(article.documentId, 'es')
    await settle()
    expect(remote.inboxDeliveries).toHaveLength(0)
    // Expected, not a problem to report: the translation waits for the default locale.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('not federating article'))
    warn.mockRestore()

    await publish(article.documentId, 'en')
    const create = await waitUntil(() => deliveriesOf('Create')[0])

    expect(Object.keys(objectOf(create).contentMap ?? {})).toEqual(['en', 'es'])
    await settle()
    expect(deliveriesOf('Update')).toHaveLength(0)
  })

  it('unpublishing a translation sends an Update without it', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await waitUntil(() => deliveriesOf('Create')[0])
    await publish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Update')[0])

    await unpublish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Update')[1])
    const update = deliveriesOf('Update')[1]

    expect(Object.keys(objectOf(update).contentMap ?? {})).toEqual(['en'])
    expect(Object.keys(objectOf(update).nameMap ?? {})).toEqual(['en'])
    // No published row changed: the time of the refresh is what tells it from the map before.
    expect(Date.parse(objectOf(update).updated!)).toBeGreaterThan(
      Date.parse(objectOf(deliveriesOf('Update')[0]).updated!)
    )
    await settle()
    expect(deliveriesOf('Delete')).toHaveLength(0)
  })

  it('unpublishing a translation that rode in the Create sends an Update with an updated', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'es')
    await publish(article.documentId, 'en')
    const create = await waitUntil(() => deliveriesOf('Create')[0])

    await unpublish(article.documentId, 'es')
    const update = await waitUntil(() => deliveriesOf('Update')[0])

    // No published row changed after the Create: the refresh's own time is all there is.
    expect(Object.keys(objectOf(update).contentMap ?? {})).toEqual(['en'])
    expect(Date.parse(objectOf(update).updated!)).toBeGreaterThan(
      Date.parse(objectOf(create).updated ?? objectOf(create).published!)
    )
  })

  it('Federate now after a translation is unpublished sends an updated that is not older than the refresh', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await waitUntil(() => deliveriesOf('Create')[0])
    await publish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Update')[0])
    await unpublish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Update')[1])
    const refresh = deliveriesOf('Update')[1]

    // The panel's "Federate now"; the retry of a failed delivery goes through the same function.
    await request(strapi.server.httpServer)
      .post(`/fediverse-panel/articles/${article.documentId}/federate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(202)
    await waitUntil(() => deliveriesOf('Update')[2])
    const again = deliveriesOf('Update')[2]

    expect(Object.keys(objectOf(again).contentMap ?? {})).toEqual(['en'])
    expect(objectOf(again).updated).toBeDefined()
    expect(Date.parse(objectOf(again).updated!)).toBeGreaterThanOrEqual(
      Date.parse(objectOf(refresh).updated!)
    )
  })

  it('deleting a translation that was never published sends nothing', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await waitUntil(() => deliveriesOf('Create')[0])

    await strapi.documents(ARTICLE_UID).delete({ documentId: article.documentId, locale: 'es' })
    await settle()

    expect(deliveriesOf('Update')).toHaveLength(0)
    expect(deliveriesOf('Delete')).toHaveLength(0)
  })

  it('deleting a published translation sends an Update without it', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await waitUntil(() => deliveriesOf('Create')[0])
    await publish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Update')[0])

    await strapi.documents(ARTICLE_UID).delete({ documentId: article.documentId, locale: 'es' })
    await waitUntil(() => deliveriesOf('Update')[1])
    await settle()

    expect(Object.keys(objectOf(deliveriesOf('Update')[1]).contentMap ?? {})).toEqual(['en'])
    expect(deliveriesOf('Update')).toHaveLength(2)
    expect(deliveriesOf('Delete')).toHaveLength(0)
  })

  it('the credit of a cover that is not there is in neither content nor contentMap', async () => {
    const title = `Credit without cover ${Date.now()}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: {
        title,
        slug: slugify(title),
        description: 'x',
        coverCredit: { kind: 'photo', author: 'Ada', license: 'cc-by-4.0' },
      } as never,
    })
    await publish(draft.documentId, 'en')
    const object = objectOf(await waitUntil(() => deliveriesOf('Create')[0]))

    expect(object.contentMap?.en).toBe(object.content)
    expect(object.content).not.toContain('Ada')
  })

  it('the outbox serves the same map as the object', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await publish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Create')[0])
    await settle()

    const res = await fetch(`http://${serverHost()}/fediverse/user/devbog/outbox?cursor=0`, {
      headers: { accept: ACTIVITY_JSON },
    })
    const page = (await res.json()) as { orderedItems?: ActivityJson[] }
    const item = (page.orderedItems ?? []).find((entry) =>
      objectOf(entry).id?.endsWith(article.documentId)
    )

    expect(Object.keys(objectOf(item!).contentMap ?? {})).toEqual(['en', 'es'])
  })

  it('unpublishing the default locale sends Delete while a translation is still published', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await waitUntil(() => deliveriesOf('Create')[0])
    await publish(article.documentId, 'es')
    await waitUntil(() => deliveriesOf('Update')[0])

    await unpublish(article.documentId, 'en')
    const del = await waitUntil(() => deliveriesOf('Delete')[0])

    expect(new URL((del.object as ActivityJson).id!).pathname).toBe(
      `/fediverse/articles/${article.documentId}`
    )
    await settle()
    expect(deliveriesOf('Delete')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(1)
  })

  it('a reply whose inReplyTo is the /es/ frontend URL attaches to the article', async () => {
    const article = await bilingualDraft()
    await publish(article.documentId, 'en')
    await publish(article.documentId, 'es')
    const replier = await createRemoteActor({ preferredUsername: 'replier-es' })
    try {
      const noteId = `${replier.actorUrl}/notes/es-1`
      const res = await replier.postSignedActivity(
        `http://${serverHost()}/fediverse/user/devbog/inbox`,
        {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${noteId}/activity`,
          type: 'Create',
          actor: replier.actorUrl,
          object: {
            id: noteId,
            type: 'Note',
            attributedTo: replier.actorUrl,
            inReplyTo: `https://blog.example.test/es/blog/articulo-${article.slug}`,
            content: '<p>Hola</p>',
            to: 'https://www.w3.org/ns/activitystreams#Public',
          },
        }
      )
      expect(res.ok).toBe(true)

      const comment = await waitUntil(() =>
        strapi.documents(COMMENT_UID).findFirst({ filters: { fediverseUri: noteId } })
      )
      expect(comment.related).toBe(`${ARTICLE_UID}:${article.documentId}`)
    } finally {
      await replier.close()
    }
  })

  it('a site with one locale sends the same content and url as before', async () => {
    const title = `Single locale ${Date.now()}`
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title, slug: slugify(title), description: 'Only English.' },
    })
    await publish(draft.documentId, 'en')
    const create = await waitUntil(() => deliveriesOf('Create')[0])
    const object = objectOf(create)
    const url = `https://blog.example.test/blog/${slugify(title)}`

    expect(object.url).toBe(url)
    expect(object.name).toBe(title)
    expect(object.content).toBe(`<p>Only English.</p><p><a href="${url}">${url}</a></p>`)
    expect(object.contentMap).toEqual({ en: object.content })
    expect(object.nameMap).toEqual({ en: title })
  })
})

describe("Fediverse localized articles (contentMap, the core's hooks)", () => {
  let remote: RemoteActor
  let defaultSite: string
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)

  bootWith(true, async () => {
    defaultSite = (
      (await strapi.db
        .query(SITE_UID)
        .findOne({ where: { isDefault: true }, select: ['documentId'] })) as { documentId: string }
    ).documentId
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader-map-hooks' })
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterEach(async () => {
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  it('unpublishing a translation of an article that was never sent sends nothing', async () => {
    const article = await bilingualDraft(defaultSite)
    await strapi.documents(ARTICLE_UID).publish({ documentId: article.documentId, locale: 'en' })
    await strapi.documents(ARTICLE_UID).publish({ documentId: article.documentId, locale: 'es' })
    await settle()
    // As an article published before the plugin was installed: no row, nothing ever sent.
    await strapi.db.query(ROW_UID).deleteMany({ where: { articleDocumentId: article.documentId } })
    const before = remote.inboxDeliveries.length

    await strapi
      .plugin('micelio')
      .service('hooks')
      .runAfter('afterUnpublish', {
        site: defaultSite,
        type: ARTICLE_UID,
        documentId: article.documentId,
        locale: 'es',
        actor: { kind: 'system' },
      })
    await settle()

    expect(remote.inboxDeliveries).toHaveLength(before)
    expect(
      await strapi.db.query(ROW_UID).findMany({ where: { articleDocumentId: article.documentId } })
    ).toHaveLength(0)
  })

  it('an editorial article federates the same map through afterPublish and afterUnpublish', async () => {
    const article = await bilingualDraft(defaultSite)
    const hooks = strapi.plugin('micelio').service('hooks')
    const run = (name: 'afterPublish' | 'afterUnpublish', locale: string) =>
      hooks.runAfter(name, {
        site: defaultSite,
        type: ARTICLE_UID,
        documentId: article.documentId,
        locale,
        actor: { kind: 'system' },
      })

    // A translation first: nothing. The core's transitions publish the entry, then run the hook.
    await strapi.documents(ARTICLE_UID).publish({ documentId: article.documentId, locale: 'es' })
    await run('afterPublish', 'es')
    await settle()
    expect(remote.inboxDeliveries).toHaveLength(0)

    await strapi.documents(ARTICLE_UID).publish({ documentId: article.documentId, locale: 'en' })
    await run('afterPublish', 'en')
    const create = await waitUntil(() => deliveriesOf('Create')[0])
    expect(Object.keys(objectOf(create).contentMap ?? {})).toEqual(['en', 'es'])

    await strapi.documents(ARTICLE_UID).unpublish({ documentId: article.documentId, locale: 'es' })
    await run('afterUnpublish', 'es')
    const update = await waitUntil(() => deliveriesOf('Update')[0])
    expect(Object.keys(objectOf(update).contentMap ?? {})).toEqual(['en'])

    await strapi.documents(ARTICLE_UID).unpublish({ documentId: article.documentId, locale: 'en' })
    await run('afterUnpublish', 'en')
    await waitUntil(() => deliveriesOf('Delete')[0])
    expect(deliveriesOf('Create')).toHaveLength(1)
    expect(deliveriesOf('Update')).toHaveLength(1)
    expect(deliveriesOf('Delete')).toHaveLength(1)
  })
})
