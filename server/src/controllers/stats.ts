import type { Core } from '@strapi/strapi'

import { findPublishedArticle } from '../services/articles'
import { isConfiguredLocale } from '../utils/configured-locale'
import { countInteractions } from '../services/interactions'
import {
  BATCH_MAX_IDS,
  RANKING_DEFAULT_PAGE_SIZE,
  RANKING_MAX_PAGE,
  RANKING_MAX_PAGE_SIZE,
  RANKING_TEXT_MAX_LENGTH,
  RANKING_SEARCH_MIN_LENGTH,
  rankArticles,
  statsForArticles,
} from '../services/stats'

/** Aggregates only, so a short shared cache is safe. */
const CACHE_CONTROL = 'public, max-age=60'

interface Context {
  params: Record<string, string>
  query: Record<string, unknown>
  body: unknown
  set: (header: string, value: string) => void
  notFound: () => void
  badRequest: (message: string) => void
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function textParam(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

/** Public fediverse counts for the frontend. Only aggregates; never who interacted. */
export default ({
  strapi,
}: {
  strapi: Core.Strapi
}): Record<'find' | 'batch' | 'ranking', (ctx: Context) => Promise<void>> => ({
  async find(ctx: Context) {
    const { documentId } = ctx.params

    // Only published articles: don't confirm that unpublished ids exist.
    if ((await findPublishedArticle(strapi, documentId)) == null) {
      ctx.notFound()
      return
    }

    ctx.body = await countInteractions(strapi, documentId)
  },

  /** `GET /articles/stats?documentIds=a,b,c`, answered as `{ [documentId]: { likes, boosts, replies } }`. */
  async batch(ctx: Context) {
    const raw = ctx.query.documentIds
    const ids = [
      ...new Set(
        (Array.isArray(raw) ? raw : [raw])
          .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
          .map((id) => id.trim())
          .filter(Boolean)
      ),
    ]
    if (ids.length === 0) {
      ctx.badRequest('documentIds is required')
      return
    }
    if (ids.length > BATCH_MAX_IDS) {
      ctx.badRequest(`documentIds accepts at most ${BATCH_MAX_IDS} ids`)
      return
    }

    ctx.set('Cache-Control', CACHE_CONTROL)
    ctx.body = await statsForArticles(strapi, ids)
  },

  /** GET /articles/ranking?page=1&pageSize=6&locale=es&category=ia&tag=vue&search=rag */
  async ranking(ctx: Context) {
    const locale = textParam(ctx.query.locale)
    if (locale !== undefined && !(await isConfiguredLocale(strapi, locale))) {
      ctx.badRequest('locale is not a configured locale')
      return
    }
    const category = textParam(ctx.query.category)
    const tag = textParam(ctx.query.tag)
    const search = textParam(ctx.query.search)
    for (const [name, value] of [
      ['category', category],
      ['tag', tag],
      ['search', search],
    ] as const) {
      if (value && value.length > RANKING_TEXT_MAX_LENGTH) {
        ctx.badRequest(`${name} must be at most ${RANKING_TEXT_MAX_LENGTH} characters long`)
        return
      }
    }
    const page = Math.min(positiveInt(ctx.query.page, 1), RANKING_MAX_PAGE)
    const pageSize = Math.min(
      positiveInt(ctx.query.pageSize, RANKING_DEFAULT_PAGE_SIZE),
      RANKING_MAX_PAGE_SIZE
    )

    ctx.set('Cache-Control', CACHE_CONTROL)
    ctx.body = await rankArticles(strapi, {
      page,
      pageSize,
      locale,
      category,
      tag,
      search: search && search.length >= RANKING_SEARCH_MIN_LENGTH ? search : undefined,
    })
  },
})
