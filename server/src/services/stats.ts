import type { Core } from '@strapi/strapi'

import { ARTICLE_UID, COMMENT_UID, INTERACTION_UID } from '../constants/uids'
import type { ArticleStats, RankingOptions, RankingPage } from '../types/stats'
import { getDefaultLocale } from './articles'
import { listFollowers } from './followers'

/** Comments point at their article as `api::article.article:<documentId>`. */
const RELATED_PREFIX = `${ARTICLE_UID}:`

/** Most documentIds `GET /api/fediverse/articles/stats` accepts in one request; more is a 400. */
export const BATCH_MAX_IDS = 50
/** Ranking page size when the request gives none or an invalid one. */
export const RANKING_DEFAULT_PAGE_SIZE = 6
/** Largest ranking page size; a larger request is capped, not rejected. */
export const RANKING_MAX_PAGE_SIZE = 50
/** Shortest ranking `search` that filters; a shorter one is ignored. */
export const RANKING_SEARCH_MIN_LENGTH = 3

/** Largest ranking `page`; a larger one is clamped to it, so the offset stays small. */
export const RANKING_MAX_PAGE = 10_000
/** Longest ranking `search`, `category` or `tag` in UTF-16 code units (`String.length`); a longer one is a 400. */
export const RANKING_TEXT_MAX_LENGTH = 200

type Knex = Core.Strapi['db']['connection']
type QueryBuilder = ReturnType<Knex>

interface Model {
  table: string
  column: (attribute: string) => string
}

function model(strapi: Core.Strapi, uid: string): Model {
  const metadata = strapi.db.metadata.get(uid)
  return {
    table: metadata.tableName,
    column: (attribute) => {
      const column = (metadata.attributes[attribute] as { columnName?: string } | undefined)
        ?.columnName
      if (!column) throw new Error(`fediverse stats: ${uid} has no column for ${attribute}`)
      return column
    },
  }
}

async function blockedActorIds(strapi: Core.Strapi): Promise<string[]> {
  return (await listFollowers(strapi, { blocked: true })).map((follower) => follower.actorId)
}

/**
 * Likes and boosts per article documentId (`document_id`, `likes`, `boosts`).
 * Interactions from blocked actors don't count, as in `countInteractions`.
 */
function interactionCounts(
  strapi: Core.Strapi,
  blocked: string[],
  documentIds?: string[]
): QueryBuilder {
  const knex = strapi.db.connection
  const interaction = model(strapi, INTERACTION_UID)
  const documentId = interaction.column('articleDocumentId')
  const type = interaction.column('type')

  const query = knex(interaction.table)
    .select(`${documentId} as document_id`)
    .select(knex.raw('SUM(CASE WHEN ?? = ? THEN 1 ELSE 0 END) as likes', [type, 'like']))
    .select(knex.raw('SUM(CASE WHEN ?? = ? THEN 1 ELSE 0 END) as boosts', [type, 'boost']))
    .groupBy(documentId)
  if (blocked.length > 0) query.whereNotIn(interaction.column('actorId'), blocked)
  if (documentIds) query.whereIn(documentId, documentIds)
  return query
}

/**
 * Fediverse replies per article documentId (`document_id`, `replies`): approved
 * comments with a `fediverseUri` (set on every reply, unlike the actor handle,
 * which is null when it could not be resolved) that were not removed or blocked,
 * and whose author is not a blocked actor.
 */
function replyCounts(strapi: Core.Strapi, blocked: string[], documentIds?: string[]): QueryBuilder {
  const knex = strapi.db.connection
  const comment = model(strapi, COMMENT_UID)
  const related = comment.column('related')

  const query = knex(comment.table)
    .select(knex.raw('SUBSTR(??, ?) as document_id', [related, RELATED_PREFIX.length + 1]))
    .count({ replies: '*' })
    .where(comment.column('approvalStatus'), 'APPROVED')
    .whereNotNull(comment.column('fediverseUri'))
    .where((q) => q.whereNull(comment.column('removed')).orWhere(comment.column('removed'), false))
    .where((q) => q.whereNull(comment.column('blocked')).orWhere(comment.column('blocked'), false))
    // Grouped by the column itself: Postgres would treat two parameterized
    // SUBSTR() calls in SELECT and GROUP BY as different expressions.
    .groupBy(related)
  if (blocked.length > 0) query.whereNotIn(comment.column('authorId'), blocked)
  if (documentIds) {
    query.whereIn(
      related,
      documentIds.map((id) => `${RELATED_PREFIX}${id}`)
    )
  } else {
    query.where(related, 'like', `${RELATED_PREFIX}%`)
  }
  return query
}

/**
 * Fediverse replies to one article that a moderator has approved or has yet to review,
 * under the same rules as `replyCounts`: not removed or blocked, author not a blocked actor.
 */
export async function replyCountsByStatus(
  strapi: Core.Strapi,
  documentId: string
): Promise<{ approved: number; pending: number }> {
  const comment = model(strapi, COMMENT_UID)
  const status = comment.column('approvalStatus')
  const blocked = await blockedActorIds(strapi)

  const query = strapi.db
    .connection(comment.table)
    .select(`${status} as status`)
    .count({ replies: '*' })
    .where(comment.column('related'), `${RELATED_PREFIX}${documentId}`)
    .whereIn(status, ['APPROVED', 'PENDING'])
    .whereNotNull(comment.column('fediverseUri'))
    .where((q) => q.whereNull(comment.column('removed')).orWhere(comment.column('removed'), false))
    .where((q) => q.whereNull(comment.column('blocked')).orWhere(comment.column('blocked'), false))
    .groupBy(status)
  if (blocked.length > 0) query.whereNotIn(comment.column('authorId'), blocked)

  const counts = { approved: 0, pending: 0 }
  for (const row of (await query) as { status: string; replies: unknown }[]) {
    if (row.status === 'APPROVED') counts.approved = toNumber(row.replies)
    if (row.status === 'PENDING') counts.pending = toNumber(row.replies)
  }
  return counts
}

/** Published article rows (one per document) in `locale`. */
function publishedArticles(strapi: Core.Strapi, locale: string): QueryBuilder {
  const article = model(strapi, ARTICLE_UID)
  return strapi.db
    .connection(`${article.table} as article`)
    .whereNotNull(`article.${article.column('publishedAt')}`)
    .where(`article.${article.column('locale')}`, locale)
}

const toNumber = (value: unknown) => Number(value ?? 0)

/**
 * documentIds of the articles published in `locale` that match the filters.
 * `$containsi` is a LIKE without escaping, so rows that only matched the
 * search through `%` or `_` are dropped, as in the article search service.
 */
async function filteredDocumentIds(
  strapi: Core.Strapi,
  locale: string,
  { category, tag, search }: Pick<RankingOptions, 'category' | 'tag' | 'search'>
): Promise<string[]> {
  const rows = (await strapi.db.query(ARTICLE_UID).findMany({
    select: ['documentId', 'title'],
    where: {
      locale,
      publishedAt: { $notNull: true },
      ...(category ? { category: { slug: { $eq: category } } } : {}),
      ...(tag ? { tags: { slug: { $eq: tag } } } : {}),
      ...(search ? { title: { $containsi: search } } : {}),
    },
  })) as { documentId: string; title: string | null }[]

  const term = search?.toLocaleLowerCase()
  return [
    ...new Set(
      rows
        .filter((row) => !term || (row.title ?? '').toLocaleLowerCase().includes(term))
        .map((row) => row.documentId)
    ),
  ]
}

/**
 * Counts for several articles at once, keyed by documentId. Only articles
 * published in the default locale are included; any other id is left out, so
 * the response never confirms that an unpublished article exists.
 */
export async function statsForArticles(
  strapi: Core.Strapi,
  documentIds: string[]
): Promise<Record<string, ArticleStats>> {
  const ids = [...new Set(documentIds)]
  if (ids.length === 0) return {}

  const article = model(strapi, ARTICLE_UID)
  const locale = await getDefaultLocale(strapi)
  const blocked = await blockedActorIds(strapi)

  const [published, interactions, replies] = await Promise.all([
    publishedArticles(strapi, locale)
      .whereIn(`article.${article.column('documentId')}`, ids)
      .select(`article.${article.column('documentId')} as document_id`),
    interactionCounts(strapi, blocked, ids),
    replyCounts(strapi, blocked, ids),
  ])

  const result: Record<string, ArticleStats> = {}
  for (const row of published as { document_id: string }[]) {
    result[row.document_id] = { likes: 0, boosts: 0, replies: 0 }
  }
  for (const row of interactions as { document_id: string; likes: unknown; boosts: unknown }[]) {
    const entry = result[row.document_id]
    if (!entry) continue
    entry.likes = toNumber(row.likes)
    entry.boosts = toNumber(row.boosts)
  }
  for (const row of replies as { document_id: string; replies: unknown }[]) {
    const entry = result[row.document_id]
    if (entry) entry.replies = toNumber(row.replies)
  }
  return result
}

/**
 * Published articles in `locale` ordered by likes + boosts + replies, newest
 * first on ties. Articles without interactions come last, so paging covers the
 * whole blog. One aggregate query per page, whatever the number of articles.
 * `category`, `tag` and `search` narrow the list before ranking, so pages stay
 * consistent with the blog filters.
 */
export async function rankArticles(
  strapi: Core.Strapi,
  { page, pageSize, locale, category, tag, search }: RankingOptions
): Promise<RankingPage> {
  const knex = strapi.db.connection
  const article = model(strapi, ARTICLE_UID)
  const resolvedLocale = locale || (await getDefaultLocale(strapi))
  const blocked = await blockedActorIds(strapi)
  const filtered = Boolean(category || tag || search)
  const matching = filtered
    ? await filteredDocumentIds(strapi, resolvedLocale, { category, tag, search })
    : []
  const articles = () => {
    const query = publishedArticles(strapi, resolvedLocale)
    if (filtered) query.whereIn(`article.${article.column('documentId')}`, matching)
    return query
  }

  const documentId = `article.${article.column('documentId')}`
  const likes = 'COALESCE(interactions.likes, 0)'
  const boosts = 'COALESCE(interactions.boosts, 0)'
  const replies = 'COALESCE(replies.replies, 0)'

  const [rows, totals] = await Promise.all([
    articles()
      .leftJoin(
        interactionCounts(strapi, blocked).as('interactions'),
        'interactions.document_id',
        documentId
      )
      .leftJoin(replyCounts(strapi, blocked).as('replies'), 'replies.document_id', documentId)
      .select(`${documentId} as document_id`)
      .select(knex.raw(`${likes} as likes`))
      .select(knex.raw(`${boosts} as boosts`))
      .select(knex.raw(`${replies} as replies`))
      .orderByRaw(`${likes} + ${boosts} + ${replies} DESC`)
      .orderBy(`article.${article.column('publishedAt')}`, 'desc')
      .orderBy(`article.id`, 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    articles().count({ total: '*' }),
  ])

  // Knex types count() rows loosely; it is one row with `total`.
  const count = toNumber((totals as { total?: string | number }[])[0]?.total)
  return {
    data: (
      rows as { document_id: string; likes: unknown; boosts: unknown; replies: unknown }[]
    ).map((row) => ({
      documentId: row.document_id,
      likes: toNumber(row.likes),
      boosts: toNumber(row.boosts),
      replies: toNumber(row.replies),
    })),
    meta: {
      pagination: { page, pageSize, pageCount: Math.ceil(count / pageSize), total: count },
    },
  }
}

export default (): {
  statsForArticles: typeof statsForArticles
  rankArticles: typeof rankArticles
} => ({
  statsForArticles,
  rankArticles,
})
