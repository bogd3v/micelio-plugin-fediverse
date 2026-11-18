import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { writeFediverseProfile } from './helpers/fediverse-profile'
import type { ActivityJson } from './helpers/api-types'
import { waitUntil } from './helpers/wait-until'

const ARTICLE_UID = 'api::article.article'
const CREDIT_UID = 'shared.translation-credit'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const ACTIVITY_JSON = 'application/activity+json'
const FEP_22CD = 'https://w3id.org/fep/22cd'
const ANA = 'https://translators.example.test/users/ana'
const BEN = 'https://translators.example.test/users/ben'

interface TranslationJson {
  type?: string
  inLanguage?: string
  translator?: string[]
  translationOfWork?: string
  url?: string
  sourceUpdated?: string
  isBasedOn?: string
}

type Json = ActivityJson & {
  '@context'?: unknown
  attributedTo?: string
  contentMap?: Record<string, string>
  nameMap?: Record<string, string>
  translations?: TranslationJson[]
}

/** One locale of a test article; a `title` of `null` publishes it without one. */
interface LocaleDraft {
  title?: string | null
  credits?: string[]
}

const objectOf = (activity: ActivityJson) => activity.object as Json
const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const creditsOf = (urls: string[] = []) => urls.map((actorUrl) => ({ actorUrl }))

async function ensureLocale(code: string, name: string) {
  const locales = strapi.plugin('i18n').service('locales')
  if (!(await locales.findByCode(code))) await locales.create({ code, name })
}

/** The Strapi of a suite below, with or without the article's optional attribute. */
function bootWith(translationCredits: boolean) {
  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi({ translationCredits })
    await writeFediverseProfile({ objectType: 'article' })
    await ensureLocale('es', 'Spanish (es)')
    await ensureLocale('fr', 'French (fr)')
    await ensureLocale('pt-BR', 'Portuguese (Brazil) (pt-BR)')
  })
  afterAll(async () => {
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })
}

/** Drafts an article in `en` and in each locale of `others`, and publishes nothing. */
async function draftArticle(en: LocaleDraft, others: Record<string, LocaleDraft> = {}) {
  const title = `Credited article ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const slug = slugify(title)
  const draft = await strapi.documents(ARTICLE_UID).create({
    data: {
      title,
      slug,
      description: 'English excerpt.',
      ...(en.credits ? { translationCredits: creditsOf(en.credits) } : {}),
    } as never,
  })
  for (const [locale, entry] of Object.entries(others)) {
    await strapi.documents(ARTICLE_UID).update({
      documentId: draft.documentId,
      locale,
      data: {
        title: entry.title === null ? null : `${locale} ${title}`,
        slug: `${locale.toLowerCase()}-${slug}`,
        description: `Excerpt in ${locale}.`,
        ...(entry.credits ? { translationCredits: creditsOf(entry.credits) } : {}),
      } as never,
    })
  }
  return { documentId: draft.documentId, slug }
}

/** Publishes the translations first, so the default locale's publish sends one `Create` with all of them. */
async function publishArticle(documentId: string, others: string[] = []) {
  for (const locale of others) await strapi.documents(ARTICLE_UID).publish({ documentId, locale })
  await strapi.documents(ARTICLE_UID).publish({ documentId, locale: 'en' })
}

async function servedObject(documentId: string): Promise<Json> {
  const res = await fetch(`http://${serverHost()}/fediverse/articles/${documentId}`, {
    headers: { accept: ACTIVITY_JSON },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Json
}

describe('Fediverse translator credits (FEP-22cd)', () => {
  let remote: RemoteActor
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)

  bootWith(true)

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader-translations' })
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterEach(async () => {
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  it('a credited translation federates one Translation with its language, translators, source object and url', async () => {
    const article = await draftArticle({}, { es: { credits: [ANA, BEN] } })
    await publishArticle(article.documentId, ['es'])
    const object = objectOf(await waitUntil(() => deliveriesOf('Create')[0]))

    expect(object.translations).toEqual([
      {
        type: 'Translation',
        inLanguage: 'es',
        translator: [ANA, BEN],
        translationOfWork: object.id,
        url: `https://blog.example.test/es/blog/es-${article.slug}`,
      },
    ])
    // Credit and authorship stay apart, and the object keeps its id and its address.
    expect(new URL(object.attributedTo!).pathname).toBe('/fediverse/user/devbog')
    expect(new URL(object.id!).pathname).toBe(`/fediverse/articles/${article.documentId}`)
    expect(object.url).toBe(`https://blog.example.test/blog/${article.slug}`)
    // Served outside a delivery the object has the origin of the request, in its id too.
    const served = await servedObject(article.documentId)
    expect(served.translations?.[0].translationOfWork).toBe(served.id)
  })

  it('each Translation language is a key of contentMap', async () => {
    const article = await draftArticle(
      { credits: [ANA] },
      { es: { credits: [ANA] }, 'pt-BR': { credits: [BEN] } }
    )
    await publishArticle(article.documentId, ['es', 'pt-BR'])
    const object = await servedObject(article.documentId)

    const languages = (object.translations ?? []).map((entry) => entry.inLanguage!)
    expect(languages).toHaveLength(3)
    // JSON-LD lowercases the keys of a language map and Fedify writes `inLanguage` in canonical
    // case; BCP 47 tags are compared without regard to case.
    const keys = Object.keys(object.contentMap ?? {})
    expect(languages.map((language) => language.toLowerCase()).sort()).toEqual([...keys].sort())
  })

  it('the Note shape carries the same translations as the Article shape', async () => {
    const article = await draftArticle({}, { es: { credits: [ANA] } })
    await publishArticle(article.documentId, ['es'])
    const asArticle = await servedObject(article.documentId)

    await writeFediverseProfile({ objectType: 'note' })
    try {
      const asNote = await servedObject(article.documentId)
      expect(asArticle.type).toBe('Article')
      expect(asNote.type).toBe('Note')
      expect(asNote.translations).toHaveLength(1)
      expect(asNote.translations).toEqual(asArticle.translations)
    } finally {
      await writeFediverseProfile({ objectType: 'article' })
    }
  })

  it('the outbox serves the same translations as the object', async () => {
    const article = await draftArticle({ credits: [BEN] }, { es: { credits: [ANA] } })
    await publishArticle(article.documentId, ['es'])
    const object = await servedObject(article.documentId)

    const res = await fetch(`http://${serverHost()}/fediverse/user/devbog/outbox?cursor=0`, {
      headers: { accept: ACTIVITY_JSON },
    })
    const page = (await res.json()) as { orderedItems?: ActivityJson[] }
    const item = (page.orderedItems ?? []).find((entry) =>
      objectOf(entry).id?.endsWith(article.documentId)
    )

    expect(object.translations).toHaveLength(2)
    expect(objectOf(item!).translations).toEqual(object.translations)
  })

  it('a published locale without credits has no Translation', async () => {
    const article = await draftArticle({}, { es: { credits: [ANA] }, fr: {} })
    await publishArticle(article.documentId, ['es', 'fr'])
    const object = await servedObject(article.documentId)

    expect(Object.keys(object.contentMap ?? {})).toEqual(['en', 'es', 'fr'])
    expect(object.translations?.map((entry) => entry.inLanguage)).toEqual(['es'])
  })

  it('a credited published locale that is not in contentMap has no Translation', async () => {
    const article = await draftArticle(
      {},
      { es: { title: null, credits: [ANA] }, fr: { credits: [BEN] } }
    )
    await publishArticle(article.documentId, ['es', 'fr'])
    const object = await servedObject(article.documentId)

    expect(Object.keys(object.contentMap ?? {})).toEqual(['en', 'fr'])
    expect(object.translations?.map((entry) => entry.inLanguage)).toEqual(['fr'])
  })

  it('a credit on the default locale gives that locale a Translation', async () => {
    const article = await draftArticle({ credits: [ANA] }, { es: {} })
    await publishArticle(article.documentId, ['es'])
    const object = await servedObject(article.documentId)

    expect(object.translations).toEqual([
      {
        type: 'Translation',
        inLanguage: 'en',
        translator: [ANA],
        translationOfWork: object.id,
        url: `https://blog.example.test/blog/${article.slug}`,
      },
    ])
  })

  it('an object whose contentMap has one locale sends no translations', async () => {
    const article = await draftArticle({ credits: [ANA] })
    await publishArticle(article.documentId)
    const object = objectOf(await waitUntil(() => deliveriesOf('Create')[0]))

    expect(Object.keys(object.contentMap ?? {})).toEqual(['en'])
    expect(object.translations).toBeUndefined()
    expect((await servedObject(article.documentId)).translations).toBeUndefined()
  })

  it('no Translation carries sourceUpdated or isBasedOn', async () => {
    const article = await draftArticle({ credits: [ANA] }, { es: { credits: [BEN] } })
    await publishArticle(article.documentId, ['es'])
    const object = await servedObject(article.documentId)

    expect(object.translations).toHaveLength(2)
    for (const entry of object.translations ?? []) {
      expect(entry).not.toHaveProperty('sourceUpdated')
      expect(entry).not.toHaveProperty('isBasedOn')
    }
  })

  it('unpublishing a translation sends an Update without its contentMap entry and its Translation', async () => {
    const article = await draftArticle({}, { es: { credits: [ANA] }, fr: { credits: [BEN] } })
    await publishArticle(article.documentId, ['es', 'fr'])
    const create = objectOf(await waitUntil(() => deliveriesOf('Create')[0]))
    expect(create.translations?.map((entry) => entry.inLanguage)).toEqual(['es', 'fr'])

    await strapi.documents(ARTICLE_UID).unpublish({ documentId: article.documentId, locale: 'es' })
    const update = objectOf(await waitUntil(() => deliveriesOf('Update')[0]))

    expect(Object.keys(update.contentMap ?? {})).toEqual(['en', 'fr'])
    expect(update.translations?.map((entry) => entry.inLanguage)).toEqual(['fr'])
  })

  it('a credit whose actorUrl is not an https URL without credentials is left out', async () => {
    // These pass the attribute's regex, so a host's editor can save them.
    const savedByAnEditor = [
      'https://user:secret@translators.example.test/users/a',
      'https://user@translators.example.test/users/b',
      'https://:secret@translators.example.test/users/i',
      'https:///users/i',
      'https://\\users/a',
    ]
    // A host may declare the attribute without the regex: written past the validation of the app.
    const refusedByRegex = [
      'http://translators.example.test/users/c',
      'ftp://translators.example.test/users/d',
      '/users/e',
      'translators.example.test/users/f',
      'https:translators.example.test/users/g',
      ' https://translators.example.test/users/h',
      'https://',
    ]
    const placeholders = refusedByRegex.map(
      (_, index) => `https://placeholder-${index}.example.test/users/x`
    )
    const article = await draftArticle(
      {},
      {
        // Two lists: the attribute holds at most 10 credits per locale.
        es: { credits: [...placeholders, ANA] },
        fr: { credits: savedByAnEditor },
      }
    )
    await publishArticle(article.documentId, ['es', 'fr'])
    for (const [index, actorUrl] of refusedByRegex.entries()) {
      await strapi.db
        .query(CREDIT_UID)
        .updateMany({ where: { actorUrl: placeholders[index] }, data: { actorUrl } })
    }

    const object = await servedObject(article.documentId)

    // `fr` has credits, none usable: the locale reads as directly authored.
    expect(object.translations?.map((entry) => entry.inLanguage)).toEqual(['es'])
    expect(object.translations?.[0].translator).toEqual([ANA])
  })

  it('building the object makes no request to a credited actor', async () => {
    const credited = new URL(ANA).host
    const requested = vi.spyOn(globalThis, 'fetch')
    try {
      const article = await draftArticle({ credits: [ANA] }, { es: { credits: [ANA] } })
      await publishArticle(article.documentId, ['es'])
      await waitUntil(() => deliveriesOf('Create')[0])
      expect((await servedObject(article.documentId)).translations).toHaveLength(2)

      const hosts = requested.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : String(input)).host
      )
      expect(hosts).toContain(serverHost())
      expect(hosts).not.toContain(credited)
    } finally {
      requested.mockRestore()
    }
  })

  it('an object without credits has no FEP-22cd context', async () => {
    const article = await draftArticle({}, { es: {} })
    await publishArticle(article.documentId, ['es'])
    const create = await waitUntil(() => deliveriesOf('Create')[0])
    const object = await servedObject(article.documentId)

    expect(Object.keys(object.contentMap ?? {})).toEqual(['en', 'es'])
    expect(object.translations).toBeUndefined()
    expect(JSON.stringify(object['@context'])).not.toContain(FEP_22CD)
    expect(JSON.stringify((create as Json)['@context'])).not.toContain(FEP_22CD)
  })
})

describe('Fediverse translator credits on a host without the attribute', () => {
  bootWith(false)

  it('a host whose article has no translationCredits attribute federates the same object as before', async () => {
    const contentType = strapi.contentType(ARTICLE_UID as never) as unknown as {
      attributes: Record<string, unknown>
    }
    expect(contentType.attributes.translationCredits).toBeUndefined()

    const article = await draftArticle({}, { es: {} })
    await publishArticle(article.documentId, ['es'])
    const object = await servedObject(article.documentId)
    const url = `https://blog.example.test/blog/${article.slug}`
    const esUrl = `https://blog.example.test/es/blog/es-${article.slug}`

    expect(object.url).toBe(url)
    expect(object.content).toBe(`<p>English excerpt.</p><p><a href="${url}">${url}</a></p>`)
    expect(object.contentMap).toEqual({
      en: object.content,
      es: `<p>Excerpt in es.</p><p><a href="${esUrl}">${esUrl}</a></p>`,
    })
    expect(object.translations).toBeUndefined()
    expect(JSON.stringify(object['@context'])).not.toContain(FEP_22CD)
  })
})
