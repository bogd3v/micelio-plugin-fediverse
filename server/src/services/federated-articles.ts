import type { Core } from '@strapi/strapi'

import { FEDERATED_ARTICLE_UID } from '../constants/uids'
import type {
  FederatedActivityType,
  FederatedArticleRow,
  FederatedArticleStatus,
} from '../types/federated-articles'
import { describeDeliveryError } from '../utils/delivery-error'

/** Plugin store key that held the federated article ids before the content type. */
const LEGACY_STORE_KEY = 'federatedArticles'
/** Ids per `$in` filter, under the 999 variables SQLite accepts in one statement. */
const MIGRATION_CHUNK = 500

const STATUS_OF: Record<FederatedActivityType, FederatedArticleStatus> = {
  Create: 'created',
  Update: 'updated',
  Delete: 'deleted',
}

// The article is referenced by documentId rather than a relation, as the
// interactions are: articles are draft-and-publish and localized.
function query(strapi: Core.Strapi) {
  return strapi.db.query(FEDERATED_ARTICLE_UID)
}

/**
 * Keeps the oldest row of an article and deletes the others. Strapi's
 * `unique: true` creates no database index, so concurrent inserts through
 * `db.query` can both succeed; every writer settles the set after inserting,
 * as `services/interactions.ts` does, so exactly one row survives.
 */
async function settleDuplicates(
  strapi: Core.Strapi,
  articleDocumentId: string
): Promise<FederatedArticleRow> {
  const rows = (await query(strapi).findMany({
    where: { articleDocumentId },
    orderBy: { id: 'asc' },
  })) as FederatedArticleRow[]
  const [oldest, ...duplicates] = rows
  for (const duplicate of duplicates) {
    await query(strapi).delete({ where: { documentId: duplicate.documentId } })
  }
  return oldest
}

/** The federation row of an article, or `null` when no activity was ever queued for it. */
export async function findFederatedArticle(
  strapi: Core.Strapi,
  articleDocumentId: string
): Promise<FederatedArticleRow | null> {
  return (await query(strapi).findOne({
    where: { articleDocumentId },
    orderBy: { id: 'asc' },
  })) as FederatedArticleRow | null
}

/**
 * The `published` of each article's federated object, by documentId: `createSentAt` of its row.
 * An article with no row, one that was retracted (its next `Create` starts over) or one migrated
 * from the old store key (no `createSentAt`) is left out.
 */
export async function findFirstPublished(
  strapi: Core.Strapi,
  articleDocumentIds: string[]
): Promise<Map<string, string>> {
  const first = new Map<string, string>()
  // The model exists only while the plugin is enabled; the article builders are also read without it.
  if (articleDocumentIds.length === 0 || !strapi.db.metadata.has(FEDERATED_ARTICLE_UID))
    return first
  const rows = (await query(strapi).findMany({
    where: { articleDocumentId: { $in: articleDocumentIds } },
    orderBy: { id: 'asc' },
  })) as FederatedArticleRow[]
  for (const row of rows) {
    // Duplicate rows are possible (risk 8): the oldest wins, as everywhere else.
    if (row.status === 'deleted' || !row.createSentAt || first.has(row.articleDocumentId)) continue
    first.set(row.articleDocumentId, new Date(row.createSentAt).toISOString())
  }
  return first
}

/** The most recent rows whose last activity ended `failed`, newest first. */
export async function listFailedRows(
  strapi: Core.Strapi,
  limit: number
): Promise<FederatedArticleRow[]> {
  return (await query(strapi).findMany({
    where: { status: 'failed' },
    orderBy: { lastActivityAt: 'desc' },
    limit,
  })) as FederatedArticleRow[]
}

/**
 * The activity to send for an article's current published version, given its row.
 *
 * @remarks
 * A `Create` unless remote servers can already hold the object: an article with no row, or one that
 * was retracted, is a `Create`. A row that is `failed` says the last activity was given up on, not
 * that the others worked, so a failed `Create` stays a `Create` (an `Update` of an object a
 * follower never received is ignored, as Mastodon does) and a failed `Update` an `Update`.
 */
export function activityTypeFor(row: FederatedArticleRow | null): 'Create' | 'Update' {
  if (row == null || row.status === 'deleted') return 'Create'
  if (row.status === 'failed') return row.lastActivityType === 'Update' ? 'Update' : 'Create'
  return 'Update'
}

/** Whether the article has been sent and not retracted, so a re-publish becomes an `Update`. */
export async function isFederated(
  strapi: Core.Strapi,
  articleDocumentId: string
): Promise<boolean> {
  const row = (await query(strapi).findOne({
    where: { articleDocumentId },
    orderBy: { id: 'asc' },
  })) as FederatedArticleRow | null
  // A failed delivery still counts: the article may have reached some followers.
  return row != null && row.status !== 'deleted'
}

/**
 * Records that an activity is about to be sent for the article and returns the
 * timestamp that identifies it, for `recordFailure`.
 *
 * @remarks
 * Written before delivering on purpose: an unpublish that lands mid-delivery,
 * or a delivery that fails for one follower, must still end in a `Delete`.
 * `attempts` restarts at 1 for each new activity. `createSentAt` is set by a
 * `Create` and kept by the others: it is the `published` of the object that `Create`
 * carried (`firstPublishedAt`, else the time it was queued), which every later
 * activity and the served object repeat.
 *
 * @param firstPublishedAt - For a `Create`, the `published` its object carries.
 */
export async function recordSend(
  strapi: Core.Strapi,
  articleDocumentId: string,
  type: FederatedActivityType,
  firstPublishedAt?: string
): Promise<string> {
  const now = new Date().toISOString()
  // What the `Create` carried as `published`: later activities repeat it (#321).
  const createSentAt = firstPublishedAt ?? now
  const data = {
    status: STATUS_OF[type],
    lastActivityAt: now,
    lastActivityType: type,
    attempts: 1,
    lastError: null,
  }

  const existing = (await query(strapi).findOne({
    where: { articleDocumentId },
    orderBy: { id: 'asc' },
  })) as FederatedArticleRow | null
  if (existing) {
    await query(strapi).update({
      where: { id: existing.id },
      data: type === 'Create' ? { ...data, createSentAt } : data,
    })
    return now
  }

  const created = (await query(strapi).create({
    data: { articleDocumentId, createSentAt: type === 'Create' ? createSentAt : null, ...data },
  })) as FederatedArticleRow
  const oldest = await settleDuplicates(strapi, articleDocumentId)
  if (oldest.id !== created.id) {
    await query(strapi).update({ where: { id: oldest.id }, data })
  }
  return now
}

/**
 * Marks the activity identified by `activityAt` as failed and keeps why.
 * Does nothing when a newer activity has been recorded since, so a slow failure
 * never overwrites the state of a later publish or unpublish.
 */
export async function recordFailure(
  strapi: Core.Strapi,
  articleDocumentId: string,
  activityAt: string,
  error: unknown
): Promise<void> {
  await query(strapi).update({
    where: { articleDocumentId, lastActivityAt: activityAt },
    data: { status: 'failed', lastError: describeDeliveryError(error) },
  })
}

/**
 * Records that delivering the article's last activity to one inbox failed.
 *
 * @remarks
 * Does nothing unless the row's last activity is of `type`, so a failure of a `Create` cannot
 * overwrite a later `Update`. It cannot tell two activities of one type apart: a late failure of
 * an earlier `Update` (or of a `Create` before a re-publish) lands on the newer one.
 * `attempts` only grows, so the inbox that has been retried most is the one
 * shown. The status turns `failed` only when delivery to that inbox is
 * abandoned; while retries remain the row keeps its status and shows the last
 * error. A delivery that later succeeds clears nothing: Fedify has no callback
 * for a delivery that worked, so a row that stays `created` means "queued",
 * never "delivered".
 *
 * @param attempts - Delivery attempts made or scheduled for that inbox.
 * @param abandoned - Whether Fedify will not try that inbox again.
 */
export async function recordDeliveryFailure(
  strapi: Core.Strapi,
  articleDocumentId: string,
  type: FederatedActivityType,
  { attempts, abandoned, error }: { attempts: number; abandoned: boolean; error: unknown }
): Promise<void> {
  const row = (await query(strapi).findOne({
    where: { articleDocumentId },
    orderBy: { id: 'asc' },
  })) as FederatedArticleRow | null
  if (row == null || row.lastActivityType !== type) return
  await query(strapi).update({
    where: { id: row.id },
    data: {
      attempts: Math.max(row.attempts ?? 0, attempts),
      lastError: describeDeliveryError(error),
      ...(abandoned ? { status: 'failed' } : {}),
    },
  })
}

function legacyIds(value: unknown): string[] {
  return value != null && typeof value === 'object' ? Object.keys(value) : []
}

/**
 * Turns every id of the old `federatedArticles` store key into a row with
 * `status: created` and no `createSentAt`. Idempotent: an article that already
 * has a row is left untouched, and the key stays in place for one release line
 * so a rollback still finds it.
 *
 * @returns How many rows were created.
 */
export async function migrateFederatedArticles(strapi: Core.Strapi): Promise<number> {
  const stored: unknown = await strapi
    .store({ type: 'plugin', name: 'fediverse' })
    .get({ key: LEGACY_STORE_KEY })
  const ids = legacyIds(stored)

  let created = 0
  for (let start = 0; start < ids.length; start += MIGRATION_CHUNK) {
    const chunk = ids.slice(start, start + MIGRATION_CHUNK)
    const known = new Set(
      (
        (await query(strapi).findMany({
          where: { articleDocumentId: { $in: chunk } },
        })) as FederatedArticleRow[]
      ).map((row) => row.articleDocumentId)
    )
    for (const articleDocumentId of chunk.filter((id) => !known.has(id))) {
      await query(strapi).create({
        data: { articleDocumentId, status: 'created', createSentAt: null, attempts: 0 },
      })
      await settleDuplicates(strapi, articleDocumentId)
      created += 1
    }
  }
  if (created > 0) {
    strapi.log.info(`[fediverse] migrated ${created} federated article(s) from the plugin store`)
  }
  return created
}

export default (): {
  isFederated: typeof isFederated
  activityTypeFor: typeof activityTypeFor
  recordSend: typeof recordSend
  recordFailure: typeof recordFailure
  listFailedRows: typeof listFailedRows
  recordDeliveryFailure: typeof recordDeliveryFailure
  migrateFederatedArticles: typeof migrateFederatedArticles
} => ({
  isFederated,
  activityTypeFor,
  recordSend,
  recordFailure,
  listFailedRows,
  recordDeliveryFailure,
  migrateFederatedArticles,
})
