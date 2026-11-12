import type { Core } from '@strapi/strapi'

import { Temporal } from '@js-temporal/polyfill'
import type { Context } from '@fedify/fedify'
import {
  Article,
  Create,
  Delete,
  Image,
  LanguageString,
  Note,
  PUBLIC_COLLECTION,
  Tombstone,
  Update,
  type Activity,
} from '@fedify/fedify/vocab'

import { CREDIT_KINDS, LICENSES } from '../constants/licenses'
import { ARTICLE_PATH } from '../constants/paths'
import { ARTICLE_UID, SITE_UID } from '../constants/uids'
import type {
  ArticleLocale,
  ArticleRecord,
  FederatedObjectType,
  MediaRecord,
} from '../types/articles'
import type { FederatedActivityType } from '../types/federated-articles'
import { findFirstPublished } from './federated-articles'
import { resolveSite } from './sites'
import { escapeHtml } from '../utils/html'
import { frontendBaseUrl } from '../utils/frontend-url'

/** `shared.image-credit` of the cover. */
interface ImageCreditRow {
  kind?: string | null
  author?: string | null
  authorUrl?: string | null
  source?: string | null
  sourceUrl?: string | null
  license?: string | null
  licenseUrl?: string | null
  modifications?: string | null
}

interface MediaRow {
  url?: string | null
  mime?: string | null
  alternativeText?: string | null
}

interface ArticleRow {
  documentId: string
  title?: string | null
  description?: string | null
  slug?: string | null
  locale?: string | null
  publishedAt?: string | null
  updatedAt?: string | null
  cover?: MediaRow | null
  coverCredit?: ImageCreditRow | null
  seo?: { metaImage?: MediaRow | null } | null
}

/** `cover` and `seo.metaImage`, the media the federated preview can come from. */
const ARTICLE_POPULATE = {
  cover: true,
  coverCredit: true,
  seo: { populate: { metaImage: true } },
}

let warnedLocaleVariable = false

/**
 * The locale the frontend serves without a prefix: `defaultLocale` of the site, and only when the
 * site has none, `FRONTEND_DEFAULT_LOCALE` (deprecated; it logs a warning, once) and then `en`.
 *
 * @param site - The site's `documentId`; the default site when omitted.
 */
export async function frontendDefaultLocale(strapi: Core.Strapi, site?: string): Promise<string> {
  let fromSite: string | null | undefined
  try {
    const row = (await strapi.documents(SITE_UID).findOne({
      documentId: await resolveSite(strapi, site),
    })) as { defaultLocale?: string | null } | null
    fromSite = row?.defaultLocale
  } catch {
    // No site to read yet (the boot has not created it): the variable and the default still apply.
  }
  if (fromSite) return fromSite
  const fromVariable = process.env.FRONTEND_DEFAULT_LOCALE?.trim()
  if (!fromVariable) return 'en'
  if (!warnedLocaleVariable) {
    warnedLocaleVariable = true
    strapi.log.warn(
      "[fediverse] FRONTEND_DEFAULT_LOCALE is deprecated and read only because the site has no default locale: set the site's Default locale instead"
    )
  }
  return fromVariable
}

/**
 * Human-facing URL of an article on the frontend (`FRONTEND_URL` +
 * `FRONTEND_ARTICLE_PATH`). The frontend serves its default locale without a
 * prefix (Nuxt i18n `prefix_except_default`) and every other locale under
 * `/<locale>`, so an article whose locale differs from the site's default locale
 * gets that prefix — otherwise the link would open the wrong language.
 *
 * @param frontendDefault - The locale the frontend serves unprefixed, from
 * {@link frontendDefaultLocale}; `en` when omitted.
 */
export function getFrontendArticleUrl(
  slug: string,
  locale?: string | null,
  frontendDefault: string = 'en'
): URL {
  const base = frontendBaseUrl().replace(/\/+$/, '')
  const path = process.env.FRONTEND_ARTICLE_PATH ?? '/blog/{slug}'
  const prefix = locale && locale !== frontendDefault ? `/${locale}` : ''
  return new URL(base + prefix + path.replace('{slug}', encodeURIComponent(slug)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Inverse of {@link getFrontendArticleUrl}: extracts the slug (and locale) from
 * a frontend article URL, or null if the URL isn't one of ours. Some clients
 * reply using an article's `url` rather than its ActivityPub `id`.
 */
export function parseFrontendArticleUrl(
  value: string,
  frontendDefault: string = 'en'
): { slug: string; locale: string } | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const base = new URL(frontendBaseUrl())
  if (url.origin !== base.origin) return null

  const template = process.env.FRONTEND_ARTICLE_PATH ?? '/blog/{slug}'
  const [before, after] = template.split('{slug}')
  const basePath = base.pathname.replace(/\/+$/, '')
  const pattern = new RegExp(
    `^${escapeRegExp(basePath)}(?:/([A-Za-z]{2}(?:-[A-Za-z]{2})?))?${escapeRegExp(before)}([^/]+)${escapeRegExp(after ?? '')}/?$`
  )
  const match = pattern.exec(url.pathname)
  if (!match) return null

  return {
    locale: match[1] ?? frontendDefault,
    slug: decodeURIComponent(match[2]),
  }
}

/** documentId of the published article behind a frontend URL, or null. */
export async function findArticleDocumentIdByUrl(
  strapi: Core.Strapi,
  value: string
): Promise<string | null> {
  const parsed = parseFrontendArticleUrl(value, await frontendDefaultLocale(strapi))
  if (!parsed) return null
  const row = (await strapi.documents(ARTICLE_UID).findFirst({
    status: 'published',
    locale: parsed.locale,
    filters: { slug: parsed.slug },
  })) as ArticleRow | null
  return row?.documentId ?? null
}

/**
 * Maps a URI a remote server used for one of our articles to its documentId:
 * either the ActivityPub object id (via `parseArticleUri`) or, since some
 * clients use the `url`, the frontend URL.
 */
export async function resolveArticleId(
  strapi: Core.Strapi,
  uri: string,
  parseArticleUri: (uri: string) => string | null
): Promise<string | null> {
  return parseArticleUri(uri) ?? (await findArticleDocumentIdByUrl(strapi, uri))
}

/** The locale an article must have published to be federated: its anchor. */
export async function getDefaultLocale(strapi: Core.Strapi): Promise<string> {
  const locale = await strapi.plugin('i18n').service('locales').getDefaultLocale()
  return locale as string
}

/**
 * Media usable as the preview image: it must have a URL and, when the mime type
 * is known, be an image — `cover` and `metaImage` also accept videos and files.
 */
function toImage(
  media: MediaRow | null | undefined,
  creditHtml: string | null = null
): MediaRecord | null {
  if (!media?.url) return null
  if (media.mime && !media.mime.startsWith('image/')) return null
  return {
    url: media.url,
    mime: media.mime ?? null,
    alternativeText: media.alternativeText ?? null,
    creditHtml,
  }
}

function link(text: string, href: string | null | undefined, rel = 'nofollow noopener'): string {
  const label = escapeHtml(text)
  return href ? `<a href="${escapeHtml(href)}" rel="${rel}">${label}</a>` : label
}

/**
 * The cover's attribution as one line of HTML, as the frontend shows it:
 * «Foto: Danielfjio · Wikimedia Commons · CC BY-SA 4.0 · recortada». Licenses
 * such as CC BY require it wherever the image is shared, remote timelines
 * included. Null when there is no credit.
 */
export function formatCreditHtml(
  credit: ImageCreditRow | null | undefined,
  locale: string | null
): string | null {
  if (!credit?.license) return null
  const lang = locale?.startsWith('es') ? 'es' : 'en'
  const license = LICENSES[credit.license]
  const parts = [
    credit.author ? link(credit.author, credit.authorUrl) : null,
    credit.source || credit.sourceUrl
      ? link(credit.source || credit.sourceUrl!, credit.sourceUrl)
      : null,
    license
      ? link(license.label[lang], credit.licenseUrl || license.url, 'license nofollow noopener')
      : null,
    credit.modifications ? escapeHtml(credit.modifications) : null,
  ].filter((part): part is string => part != null)
  if (parts.length === 0) return null
  const kind = CREDIT_KINDS[credit.kind ?? 'photo']?.[lang] ?? CREDIT_KINDS.photo[lang]
  return `${kind}: ${parts.join(' · ')}`
}

function toLocale(row: ArticleRow): ArticleLocale | null {
  // Federating an article without a slug would produce a broken frontend URL.
  if (!row.slug || !row.title || !row.locale) return null
  return {
    locale: row.locale,
    title: row.title,
    description: row.description ?? '',
    slug: row.slug,
    // The credit is shown only with the cover it belongs to, as in the default locale's `content`.
    creditHtml:
      toImage(row.cover, formatCreditHtml(row.coverCredit, row.locale))?.creditHtml ?? null,
    publishedAt: row.publishedAt ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

function toRecord(row: ArticleRow): ArticleRecord | null {
  if (!row.slug || !row.title || !row.publishedAt) return null
  const own = toLocale(row)
  return {
    locales: own ? [own] : [],
    documentId: row.documentId,
    title: row.title,
    description: row.description ?? '',
    slug: row.slug,
    locale: row.locale ?? null,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt ?? null,
    firstPublishedAt: row.publishedAt,
    // The article's own image takes priority; the SEO image is only a fallback.
    image:
      toImage(row.cover, formatCreditHtml(row.coverCredit, row.locale ?? null)) ??
      toImage(row.seo?.metaImage),
  }
}

/**
 * The published, default-locale version of an article, with every other published locale in
 * `locales` (default first), or null while the default locale is not published.
 */
export async function findPublishedArticle(
  strapi: Core.Strapi,
  documentId: string
): Promise<ArticleRecord | null> {
  const locale = await getDefaultLocale(strapi)
  const row = (await strapi.documents(ARTICLE_UID).findOne({
    documentId,
    status: 'published',
    locale,
    populate: ARTICLE_POPULATE,
  })) as ArticleRow | null
  const record = row ? toRecord({ ...row, locale: row.locale ?? locale }) : null
  if (record == null) return null
  return (await withFirstPublished(strapi, await withLocales(strapi, [record])))[0]
}

/**
 * Fills `locales` of each record with every published locale of its document, the record's own
 * (default) locale first and the others by code, and moves `updatedAt` to the latest change of any
 * of them: publishing or saving a translation is a change of the object, though the default
 * locale's row did not move.
 */
async function withLocales(
  strapi: Core.Strapi,
  records: ArticleRecord[]
): Promise<ArticleRecord[]> {
  if (records.length === 0) return records
  const rows = (await strapi.documents(ARTICLE_UID).findMany({
    status: 'published',
    locale: '*',
    filters: { documentId: { $in: records.map((record) => record.documentId) } },
    populate: { cover: true, coverCredit: true },
    limit: -1,
  })) as ArticleRow[]
  return records.map((record) => {
    const others = rows
      .filter((row) => row.documentId === record.documentId && row.locale !== record.locale)
      .sort((a, b) => (a.locale ?? '').localeCompare(b.locale ?? ''))
      .map(toLocale)
      .filter((entry): entry is ArticleLocale => entry != null)
    const locales = [...record.locales, ...others]
    const times = locales
      .flatMap((entry) => [entry.publishedAt, entry.updatedAt])
      .concat(record.updatedAt)
      .filter((value): value is string => value != null)
      .map((value) => new Date(value).getTime())
    return {
      ...record,
      locales,
      updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : record.updatedAt,
    }
  })
}

/** Sets `firstPublishedAt` from what was federated, so the object keeps one `published` for life. */
async function withFirstPublished(
  strapi: Core.Strapi,
  records: ArticleRecord[]
): Promise<ArticleRecord[]> {
  const first = await findFirstPublished(
    strapi,
    records.map((record) => record.documentId)
  )
  return records.map((record) => ({
    ...record,
    firstPublishedAt: first.get(record.documentId) ?? record.publishedAt,
  }))
}

/** Published default-locale articles, newest first. */
export async function listPublishedArticles(
  strapi: Core.Strapi,
  { start, limit }: { start: number; limit: number }
): Promise<{ items: ArticleRecord[]; total: number }> {
  const locale = await getDefaultLocale(strapi)
  const documents = strapi.documents(ARTICLE_UID)
  const [rows, total] = await Promise.all([
    documents.findMany({
      status: 'published',
      locale,
      sort: 'publishedAt:desc',
      start,
      limit,
      populate: ARTICLE_POPULATE,
    }) as Promise<ArticleRow[]>,
    documents.count({ status: 'published', locale }),
  ])
  const items = await withFirstPublished(
    strapi,
    await withLocales(
      strapi,
      rows
        .map((row) => toRecord({ ...row, locale: row.locale ?? locale }))
        .filter((record): record is ArticleRecord => record != null)
    )
  )
  return { items, total }
}

/** An ISO date as the `Temporal.Instant` Fedify takes for `published` and `updated`. */
export function toInstant(value: string): Temporal.Instant {
  return Temporal.Instant.from(new Date(value).toISOString())
}

/**
 * The `updated` of the object: when the current version went live or was last saved, whichever is
 * later, and none while that is not after `published`. Strapi keeps the draft's `updatedAt` when
 * it publishes, so `updatedAt` alone can precede `publishedAt` (#320), which GoToSocial refuses.
 */
function updatedOf(record: ArticleRecord): Temporal.Instant | undefined {
  const latest = Math.max(
    new Date(record.publishedAt).getTime(),
    record.updatedAt ? new Date(record.updatedAt).getTime() : -Infinity
  )
  return latest > new Date(record.firstPublishedAt).getTime()
    ? toInstant(new Date(latest).toISOString())
    : undefined
}

/** The HTML body of one locale: the title (when the shape has none of its own), the excerpt, the link and the credit. */
function bodyOf(
  entry: { title: string; description: string; creditHtml?: string | null },
  url: URL,
  includeTitle: boolean
): string {
  return [
    includeTitle ? `<p><strong>${escapeHtml(entry.title)}</strong></p>` : '',
    entry.description ? `<p>${escapeHtml(entry.description)}</p>` : '',
    `<p><a href="${escapeHtml(url.href)}">${escapeHtml(url.href)}</a></p>`,
    entry.creditHtml ? `<p><small>${entry.creditHtml}</small></p>` : '',
  ].join('')
}

/** What both shapes share: the id, the addressing, the dates, the preview image and the body. */
function objectOptions(
  ctx: Context<unknown>,
  actorIdentifier: string,
  record: ArticleRecord,
  includeTitle: boolean,
  frontendDefault?: string
) {
  const url = getFrontendArticleUrl(record.slug, record.locale, frontendDefault)
  const content = bodyOf(
    {
      title: record.title,
      description: record.description,
      creditHtml: record.image?.creditHtml ?? null,
    },
    url,
    includeTitle
  )
  // The default locale is `content`; `contentMap` adds every published locale, itself first.
  const contentMap = record.locales.map(
    (entry) =>
      new LanguageString(
        bodyOf(
          entry,
          getFrontendArticleUrl(entry.slug, entry.locale, frontendDefault),
          includeTitle
        ),
        entry.locale
      )
  )

  const cover = record.image
    ? new Image({
        url: new URL(record.image.url, ctx.origin),
        mediaType: record.image.mime ?? undefined,
        name: record.image.alternativeText ?? undefined,
      })
    : undefined

  return {
    // The id is the `Article` route whatever the type: remote servers keep it, so switching the
    // type never orphans an object already sent.
    id: ctx.getObjectUri(Article, { documentId: record.documentId }),
    attribution: ctx.getActorUri(actorIdentifier),
    contents: [content, ...contentMap],
    url,
    published: toInstant(record.firstPublishedAt),
    updated: updatedOf(record),
    image: cover,
    // GoToSocial ignores `image`; it only shows a cover that is an attachment.
    attachments: cover ? [cover] : [],
    to: PUBLIC_COLLECTION,
    ccs: [ctx.getFollowersUri(actorIdentifier)],
  }
}

/**
 * The `Article` shape: `name` and `nameMap` carry the title, so the body has the excerpt and the link only
 * (GoToSocial shows `name` as a content warning and would repeat the title in the body). `summary`
 * is deliberately unused: Mastodon shows it as a content warning.
 */
function buildArticleShape(
  options: ReturnType<typeof objectOptions>,
  record: ArticleRecord
): Article {
  return new Article({
    ...options,
    names: [
      record.title,
      ...record.locales.map((entry) => new LanguageString(entry.title, entry.locale)),
    ],
  })
}

/**
 * The `Note` shape, the one Ghost and WriteFreely send: the same body as the `Article` with no
 * `name`, so a server that reads `name` as a content warning shows the post as a regular one.
 */
function buildNoteShape(options: ReturnType<typeof objectOptions>): Note {
  return new Note(options)
}

/**
 * Builds the federated object of an article in the shape the site chose (`objectType` of the site
 * settings). Its `id` and `url` are the same for both, so switching shapes keeps every object
 * already sent dereferenceable.
 */
export function buildArticle(
  ctx: Context<unknown>,
  actorIdentifier: string,
  record: ArticleRecord,
  objectType: FederatedObjectType,
  frontendDefault?: string
): Article | Note {
  return objectType === 'note'
    ? buildNoteShape(objectOptions(ctx, actorIdentifier, record, true, frontendDefault))
    : buildArticleShape(objectOptions(ctx, actorIdentifier, record, false, frontendDefault), record)
}

/** The article and the kind of activity an activity id built by this module stands for. */
export interface ArticleActivityRef {
  documentId: string
  type: FederatedActivityType
}

const ARTICLE_PATH_PREFIX = ARTICLE_PATH.slice(0, ARTICLE_PATH.indexOf('{'))
const ACTIVITY_TYPE_OF_FRAGMENT: Array<[RegExp, FederatedActivityType]> = [
  [/^create$/, 'Create'],
  [/^update-\d+$/, 'Update'],
  [/^delete$/, 'Delete'],
]

/**
 * Reads back what `buildArticleActivity` and `buildDeleteActivity` put into an
 * activity id: the article's `documentId` and the activity type.
 *
 * @returns `null` for any other id, such as the profile `Update(Person)` or an `Accept`.
 */
export function parseArticleActivityId(id: string | undefined): ArticleActivityRef | null {
  if (id == null) return null
  let url: URL
  try {
    url = new URL(id)
  } catch {
    return null
  }
  if (!url.pathname.startsWith(ARTICLE_PATH_PREFIX)) return null
  const documentId = url.pathname.slice(ARTICLE_PATH_PREFIX.length)
  const fragment = url.hash.slice(1)
  const type = ACTIVITY_TYPE_OF_FRAGMENT.find(([pattern]) => pattern.test(fragment))?.[1]
  return documentId && !documentId.includes('/') && type ? { documentId, type } : null
}

function activityId(ctx: Context<unknown>, documentId: string, fragment: string): URL {
  const id = new URL(ctx.getObjectUri(Article, { documentId }).href)
  id.hash = fragment
  return id
}

/**
 * `Create`/`Update` wrapping the article, addressed publicly (`to: as:Public`,
 * `cc: followers`) so it can reach remote public timelines, not just followers.
 */
export function buildArticleActivity(
  kind: 'create' | 'update',
  ctx: Context<unknown>,
  actorIdentifier: string,
  record: ArticleRecord,
  objectType: FederatedObjectType,
  frontendDefault?: string
): Activity {
  const fragment = kind === 'create' ? 'create' : `update-${Date.now()}`
  const options = {
    id: activityId(ctx, record.documentId, fragment),
    actor: ctx.getActorUri(actorIdentifier),
    object: buildArticle(ctx, actorIdentifier, record, objectType, frontendDefault),
    published: toInstant(kind === 'create' ? record.firstPublishedAt : new Date().toISOString()),
    to: PUBLIC_COLLECTION,
    ccs: [ctx.getFollowersUri(actorIdentifier)],
  }
  return kind === 'create' ? new Create(options) : new Update(options)
}

/**
 * `Delete` of an article, sent when it is unpublished or deleted, with a
 * `Tombstone` in place of the object and the same public addressing as the
 * `Create`.
 */
export function buildDeleteActivity(
  ctx: Context<unknown>,
  actorIdentifier: string,
  documentId: string
): Activity {
  const objectId = ctx.getObjectUri(Article, { documentId })
  return new Delete({
    id: activityId(ctx, documentId, 'delete'),
    actor: ctx.getActorUri(actorIdentifier),
    object: new Tombstone({ id: objectId }),
    to: PUBLIC_COLLECTION,
    ccs: [ctx.getFollowersUri(actorIdentifier)],
  })
}
