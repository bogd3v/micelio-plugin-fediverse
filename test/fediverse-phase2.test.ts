import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { updateDefaultSite, writeFediverseProfile } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import type { ActivityJson } from './helpers/api-types'
import type { Modules } from '@strapi/strapi'
import type followers from '../server/src/services/followers'
import { waitUntil } from './helpers/wait-until'

const ACTIVITY_JSON = 'application/activity+json'
const ARTICLE_UID = 'api::article.article'

type ArticleInput = Modules.Documents.Params.Data.Input<typeof ARTICLE_UID>

const asArray = <T>(value: T | T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : value == null ? [] : [value]
const isPublic = (value: string | string[] | undefined) =>
  asArray(value).some((v) => /Public$/.test(v))

describe('Fediverse federation (Phase 2: article federation)', () => {
  let host: string
  let actorUrl: string
  let followersService: ReturnType<typeof followers>
  let remote: RemoteActor
  const createdDocumentIds: string[] = []

  const uniqueTitle = (label: string) => `${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  // Strapi only autogenerates the uid `slug` from the admin UI, not through the
  // document service, so tests supply it explicitly.
  const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  async function createArticle(data: ArticleInput = {}) {
    const title = data.title ?? uniqueTitle('Federated article')
    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title, slug: slugify(title), description: 'A short excerpt.', ...data },
    })
    createdDocumentIds.push(draft.documentId)
    return draft
  }

  async function publish(documentId: string, locale?: string) {
    return strapi.documents(ARTICLE_UID).publish({ documentId, ...(locale ? { locale } : {}) })
  }

  async function getJson(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(`http://${host}${path}`, {
      headers: { accept: ACTIVITY_JSON, ...headers },
    })
    // An empty object on errors: tests only read the body after checking the status.
    return { status: res.status, body: (res.ok ? await res.json() : {}) as ActivityJson }
  }

  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  const settle = (ms = 400) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  beforeAll(async () => {
    // Enable the fediverse plugin before Strapi boots (config/plugins.ts reads it).
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()

    host = serverHost()
    actorUrl = `http://${host}/fediverse/user/devbog`
    followersService = strapi.plugin('fediverse').service('followers')

    // The default is a Note (#305); this suite covers the Article shape, so it asks for it.
    await writeFediverseProfile({ objectType: 'article' })
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
    const rows = await strapi.db.query('plugin::fediverse.follower').findMany()
    for (const row of rows) {
      await strapi.db
        .query('plugin::fediverse.follower')
        .delete({ where: { documentId: row.documentId } })
    }
  })

  afterAll(async () => {
    // Let in-flight fan-out (which runs after the document operation commits)
    // finish before the harness tears the database down.
    await settle(500)
    await cleanupStrapi()
  })

  describe('Article object dispatcher', () => {
    it('serves a published article as an ActivityPub Article with a frontend url', async () => {
      const draft = await createArticle({ description: 'Why <federation> & friends matter.' })
      await publish(draft.documentId)

      const { status, body } = await getJson(`/fediverse/articles/${draft.documentId}`)

      expect(status).toBe(200)
      expect(body.type).toBe('Article')
      expect(body.id).toBe(`http://${host}/fediverse/articles/${draft.documentId}`)
      expect(body.name).toBe(draft.title)
      expect(body.url).toBe(`https://blog.example.test/blog/${draft.slug}`)
      expect(body.attributedTo).toBe(actorUrl)
      expect(isPublic(body.to)).toBe(true)
      // Untrusted-looking text in the excerpt must be escaped, not injected as markup.
      expect(body.content).toContain('Why &lt;federation&gt; &amp; friends matter.')
      expect(body.content).toContain(`https://blog.example.test/blog/${draft.slug}`)
      expect(body.published).toBeTruthy()
    })

    it('prefixes the frontend url with the locale when it is not the frontend default', async () => {
      // Strapi's default locale is `en`; the site says the frontend serves `es` unprefixed.
      await updateDefaultSite({ defaultLocale: 'es' })
      try {
        const draft = await createArticle()
        await publish(draft.documentId)

        const { body } = await getJson(`/fediverse/articles/${draft.documentId}`)

        expect(body.url).toBe(`https://blog.example.test/en/blog/${draft.slug}`)
      } finally {
        await updateDefaultSite({ defaultLocale: 'en' })
      }
    })

    describe('preview image', () => {
      // Upload rows are inserted directly: no file needs to exist to be referenced.
      async function createMedia(name: string, mime: string): Promise<{ id: number }> {
        return strapi.db.query('plugin::upload.file').create({
          data: {
            name,
            hash: name.replace(/\W/g, '_'),
            ext: `.${mime.split('/')[1]}`,
            mime,
            size: 1,
            url: `/uploads/${name}`,
            provider: 'local',
            alternativeText: `${name} alt`,
          },
        })
      }

      const seo = (metaImage: { id: number }) => ({
        metaTitle: 'SEO title',
        metaDescription: 'An SEO description that is long enough to pass the validator.',
        metaImage: metaImage.id,
      })

      async function publishedImage(data?: ArticleInput) {
        const draft = await createArticle(data)
        await publish(draft.documentId)
        const { body } = await getJson(`/fediverse/articles/${draft.documentId}`)
        return body.image
      }

      it('prefers the article cover over the SEO image', async () => {
        const cover = await createMedia('cover.png', 'image/png')
        const metaImage = await createMedia('seo.jpeg', 'image/jpeg')

        const image = await publishedImage({ cover: cover.id, seo: seo(metaImage) })

        expect(image).toMatchObject({
          url: `http://${host}/uploads/cover.png`,
          mediaType: 'image/png',
          name: 'cover.png alt',
        })
      })

      it('falls back to the SEO image when there is no cover', async () => {
        const metaImage = await createMedia('seo-only.jpeg', 'image/jpeg')

        const image = await publishedImage({ seo: seo(metaImage) })

        expect(image?.url).toBe(`http://${host}/uploads/seo-only.jpeg`)
      })

      it('skips a cover that is not an image', async () => {
        const cover = await createMedia('cover.mp4', 'video/mp4')
        const metaImage = await createMedia('seo-fallback.png', 'image/png')

        const image = await publishedImage({ cover: cover.id, seo: seo(metaImage) })

        expect(image?.url).toBe(`http://${host}/uploads/seo-fallback.png`)
      })

      it('omits the image when the article has none', async () => {
        expect(await publishedImage()).toBeUndefined()
      })
    })

    it('serves the published version of an article with unpublished changes', async () => {
      const draft = await createArticle()
      await publish(draft.documentId)
      await strapi.documents(ARTICLE_UID).update({
        documentId: draft.documentId,
        data: { title: 'Unpublished edit', description: 'Not yet public.' },
      })

      const { status, body } = await getJson(`/fediverse/articles/${draft.documentId}`)

      expect(status).toBe(200)
      expect(body.name).toBe(draft.title)
      expect(body.content).not.toContain('Not yet public.')
    })

    it('returns 404 for a draft-only article and for unknown ids', async () => {
      const draft = await createArticle()

      expect((await getJson(`/fediverse/articles/${draft.documentId}`)).status).toBe(404)
      expect((await getJson('/fediverse/articles/does-not-exist')).status).toBe(404)
    })
  })

  describe('Actor profile', () => {
    it('takes the name and summary from the site settings when Global is empty', async () => {
      // The neutral site settings micelio-cms seeds on a fresh instance (src/migrations/site-settings.ts).
      await updateDefaultSite({ name: 'Micelio', description: 'A site built with Micelio' })

      const { body } = await getJson('/fediverse/user/devbog')

      expect(body.name).toBe('Micelio')
      expect(body.summary).toContain('A site built with Micelio')
    })
  })

  describe('Outbox dispatcher', () => {
    it('is advertised on the actor so remote servers can discover it', async () => {
      const { body } = await getJson('/fediverse/user/devbog')

      expect(body.outbox).toBe(`http://${host}/fediverse/user/devbog/outbox`)
    })

    it('lists published articles as publicly-addressed Create activities, newest first', async () => {
      const older = await createArticle()
      await publish(older.documentId)
      await settle(50)
      const newer = await createArticle()
      await publish(newer.documentId)
      const draftOnly = await createArticle()

      const root = await getJson('/fediverse/user/devbog/outbox')
      expect(root.status).toBe(200)
      expect(root.body.type).toBe('OrderedCollection')
      expect(root.body.totalItems).toBeGreaterThanOrEqual(2)

      const page = await getJson('/fediverse/user/devbog/outbox?cursor=0')
      expect(page.status).toBe(200)
      const items = asArray(page.body.orderedItems)
      const ids = items.map((item) => item.object?.id?.split('/').pop())

      expect(ids).toContain(older.documentId)
      expect(ids).toContain(newer.documentId)
      expect(ids).not.toContain(draftOnly.documentId)
      expect(ids.indexOf(newer.documentId)).toBeLessThan(ids.indexOf(older.documentId))
      for (const item of items) {
        expect(item.type).toBe('Create')
        expect(isPublic(item.to)).toBe(true)
      }
    })
  })

  describe('Outbox cursor bounds', () => {
    it('never answers 500 for a huge, negative or non-numeric cursor', async () => {
      const cursors = ['99999999999999999999', '9007199254740993', '-7', 'abc', '1e309']
      for (const cursor of cursors) {
        const res = await getJson(`/fediverse/user/devbog/outbox?cursor=${cursor}`)
        expect(res.status).toBe(200)
      }
    })

    it('caps the cursor so the next one stays within bounds', async () => {
      const res = await getJson('/fediverse/user/devbog/outbox?cursor=99999999999999999999')
      expect(asArray(res.body.orderedItems)).toEqual([])
      expect(res.body.next).toBeUndefined()
    })
  })

  describe('publish fan-out', () => {
    it('sends a publicly-addressed Create(Article) to followers on publish', async () => {
      const draft = await createArticle()
      await publish(draft.documentId)

      const create = await waitUntil(() =>
        deliveriesOf('Create').find((a) => a.object?.id?.endsWith(draft.documentId))
      )

      expect(create.actor).toMatch(/\/fediverse\/user\/devbog$/)
      expect(create.object?.type).toBe('Article')
      expect(create.object?.name).toBe(draft.title)
      expect(isPublic(create.to)).toBe(true)
      expect(asArray(create.cc).some((c) => c.endsWith('/fediverse/user/devbog/followers'))).toBe(
        true
      )
    })

    it('sends Update(Article) when a federated article is edited and re-published', async () => {
      const draft = await createArticle()
      await publish(draft.documentId)
      await waitUntil(() =>
        deliveriesOf('Create').find((a) => a.object?.id?.endsWith(draft.documentId))
      )

      const newTitle = uniqueTitle('Edited title')
      await strapi
        .documents(ARTICLE_UID)
        .update({ documentId: draft.documentId, data: { title: newTitle } })
      await publish(draft.documentId)

      const update = await waitUntil(() =>
        deliveriesOf('Update').find((a) => a.object?.id?.endsWith(draft.documentId))
      )
      expect(update.object?.name).toBe(newTitle)
      expect(
        deliveriesOf('Create').filter((a) => a.object?.id?.endsWith(draft.documentId))
      ).toHaveLength(1)
    })

    it('sends Delete on unpublish, and nothing for articles that were never federated', async () => {
      const draft = await createArticle()
      await publish(draft.documentId)
      await waitUntil(() =>
        deliveriesOf('Create').find((a) => a.object?.id?.endsWith(draft.documentId))
      )

      await strapi.documents(ARTICLE_UID).unpublish({ documentId: draft.documentId })

      const del = await waitUntil(() =>
        deliveriesOf('Delete').find((a) => JSON.stringify(a.object).includes(draft.documentId))
      )
      expect(isPublic(del.to)).toBe(true)
      expect((await getJson(`/fediverse/articles/${draft.documentId}`)).status).toBe(404)

      const neverFederated = await createArticle()
      await strapi.documents(ARTICLE_UID).delete({ documentId: neverFederated.documentId })
      await settle()
      expect(
        deliveriesOf('Delete').some((a) =>
          JSON.stringify(a.object).includes(neverFederated.documentId)
        )
      ).toBe(false)
    })

    it('logs delivery failures instead of dropping them silently', async () => {
      const row = await strapi.db
        .query('plugin::fediverse.follower')
        .findOne({ where: { actorId: remote.actorUrl } })
      await strapi.db.query('plugin::fediverse.follower').update({
        where: { documentId: row.documentId },
        data: { inbox: 'http://127.0.0.1:1/inbox' },
      })
      const logError = vi.spyOn(strapi.log, 'error').mockImplementation(() => strapi.log)

      try {
        const draft = await createArticle()
        await publish(draft.documentId)

        await waitUntil(() =>
          logError.mock.calls.some(([message]) => String(message).includes('[fediverse]'))
        )
      } finally {
        logError.mockRestore()
      }
    })

    it('logs how many followers a publish was delivered to, including none', async () => {
      const logInfo = vi.spyOn(strapi.log, 'info')
      const messages = () => logInfo.mock.calls.map(([message]) => String(message))

      try {
        const first = await createArticle()
        await publish(first.documentId)
        await waitUntil(() => messages().some((m) => m.includes('queued for 1 follower')))

        const row = await strapi.db
          .query('plugin::fediverse.follower')
          .findOne({ where: { actorId: remote.actorUrl } })
        await strapi.db.query('plugin::fediverse.follower').delete({
          where: { documentId: row.documentId },
        })

        const second = await createArticle()
        await publish(second.documentId)
        await waitUntil(() => messages().some((m) => m.includes('no followers yet')))
      } finally {
        logInfo.mockRestore()
      }
    })

    it('does not deliver to blocked followers', async () => {
      const row = await strapi.db
        .query('plugin::fediverse.follower')
        .findOne({ where: { actorId: remote.actorUrl } })
      await strapi.db
        .query('plugin::fediverse.follower')
        .update({ where: { documentId: row.documentId }, data: { blocked: true } })

      const draft = await createArticle()
      await publish(draft.documentId)
      await settle(800)

      expect(remote.inboxDeliveries).toHaveLength(0)
    })

    it('only federates the default locale', async () => {
      const localesService = strapi.plugin('i18n').service('locales')
      const existing = await localesService.findByCode('es')
      if (!existing) {
        await localesService.create({ code: 'es', name: 'Spanish (es)' })
      }

      const draft = await createArticle()
      await strapi.documents(ARTICLE_UID).update({
        documentId: draft.documentId,
        locale: 'es',
        data: {
          title: uniqueTitle('Artículo en español'),
          slug: slugify(uniqueTitle('articulo-es')),
          description: 'Resumen.',
        },
      })
      await publish(draft.documentId, 'es')
      await settle(800)

      expect(remote.inboxDeliveries).toHaveLength(0)
    })
  })
})
