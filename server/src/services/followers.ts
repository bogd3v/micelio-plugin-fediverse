import type { Core } from '@strapi/strapi'

import { FOLLOWER_UID } from '../constants/uids'
import type { FollowerInput, FollowerRecord } from '../types/followers'
import { inSite, resolveSite, siteRowId } from './sites'

interface FollowerRow {
  documentId: string
  actorId: string
  handle?: string | null
  name?: string | null
  inbox?: string | null
  avatar?: string | null
  blocked?: boolean
  unreachableSince?: string | null
}

function query(strapi: Core.Strapi) {
  // db.query is used instead of strapi.documents because the plugin's
  // generated content type inputs are not visible to plugin-local TypeScript.
  return strapi.db.query(FOLLOWER_UID)
}

function toRecord(row: FollowerRow): FollowerRecord {
  return {
    documentId: row.documentId,
    actorId: row.actorId,
    handle: row.handle ?? null,
    name: row.name ?? null,
    inbox: row.inbox ?? null,
    avatar: row.avatar ?? null,
    blocked: row.blocked ?? false,
    unreachableSince: row.unreachableSince ?? null,
  }
}

/** Every row of one actor on a site, oldest first. More than one is possible: see `settleDuplicates`. */
async function rowsOf(strapi: Core.Strapi, site: string, actorId: string): Promise<FollowerRow[]> {
  return (await query(strapi).findMany({
    where: { ...inSite(site), actorId },
    orderBy: { id: 'asc' },
  })) as FollowerRow[]
}

/** Deletes the given rows unless an admin has blocked them in the meantime. */
async function deleteUnblocked(strapi: Core.Strapi, rows: FollowerRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const result = (await query(strapi).deleteMany({
    where: {
      documentId: { $in: rows.map((row) => row.documentId) },
      $or: [{ blocked: false }, { blocked: { $null: true } }],
    },
  })) as { count: number }
  return result.count
}

/**
 * Folds the rows of one actor into the oldest. `actorId` is `unique: true` only
 * in the Document Service, so concurrent Follows can each insert a row. A block
 * is never lost: the survivor is blocked when any of the rows was, and a row an
 * admin blocks while the merge runs is not deleted before its block has moved.
 *
 * @param rows - The rows of one actor, oldest first; at least one.
 */
async function settleDuplicates(
  strapi: Core.Strapi,
  site: string,
  rows: FollowerRow[]
): Promise<FollowerRow> {
  const [oldest, ...duplicates] = rows
  if (duplicates.length === 0) return oldest

  const survivor = { ...oldest }
  const block = async () => {
    if (survivor.blocked) return
    await query(strapi).update({
      where: { documentId: oldest.documentId },
      data: { blocked: true },
    })
    survivor.blocked = true
  }

  if (duplicates.some((row) => row.blocked)) await block()
  await deleteUnblocked(strapi, duplicates)

  const left = (await rowsOf(strapi, site, oldest.actorId)).filter(
    (row) => row.documentId !== oldest.documentId
  )
  if (left.length > 0) {
    await block()
    for (const row of left) {
      await query(strapi).delete({ where: { documentId: row.documentId } })
    }
  }
  return survivor
}

/**
 * Upserts a follower. Re-follows update the profile fields but never clear
 * an admin-set `blocked` flag — unblocking is a manual decision.
 *
 * @remarks
 * Concurrent Follows from one actor can each insert a row, so the rows of the actor
 * are folded into the oldest after the insert and on every later Follow.
 *
 * @param site - The `documentId` of the site the follower follows; the default site when omitted.
 */
export async function recordFollower(
  strapi: Core.Strapi,
  input: FollowerInput,
  siteId?: string
): Promise<FollowerRecord> {
  const site = await resolveSite(strapi, siteId)
  const rows = await rowsOf(strapi, site, input.actorId)
  const existing = rows.length > 0 ? await settleDuplicates(strapi, site, rows) : null

  if (existing) {
    if (existing.blocked) {
      strapi.log.warn(
        `[fediverse] ignored follow from blocked actor ${input.actorId} (blocked by admin)`
      )
      return toRecord(existing)
    }

    const updated = await query(strapi).update({
      where: { documentId: existing.documentId },
      data: {
        handle: input.handle ?? null,
        name: input.name ?? null,
        inbox: input.inbox ?? null,
        avatar: input.avatar ?? null,
      },
    })
    return toRecord(updated as FollowerRow)
  }

  const created = await query(strapi).create({
    data: {
      actorId: input.actorId,
      handle: input.handle ?? null,
      name: input.name ?? null,
      inbox: input.inbox ?? null,
      avatar: input.avatar ?? null,
      blocked: false,
      site: await siteRowId(strapi, site),
    },
  })
  // Another delivery may have inserted at the same time: keep the oldest row. If this
  // delivery lost, its profile fields are not written; both come from the same actor.
  // An Undo can also have removed the row already, hence the fallback.
  const settled = await rowsOf(strapi, site, input.actorId)
  return toRecord(
    settled.length > 0 ? await settleDuplicates(strapi, site, settled) : (created as FollowerRow)
  )
}

/**
 * Deletes every row of a remote actor, on `Undo(Follow)` or `Block`.
 *
 * @remarks
 * A row an admin has blocked is kept: the block is the admin's decision, and
 * the blocked actor must not be able to lift it by undoing its own follow.
 *
 * @param site - The `documentId` of the site; the default site when omitted.
 * @returns `false` when the actor had no row, or when any of its rows is blocked.
 */
export async function removeFollower(
  strapi: Core.Strapi,
  actorId: string,
  siteId?: string
): Promise<boolean> {
  const rows = await rowsOf(strapi, await resolveSite(strapi, siteId), actorId)
  if (rows.length === 0) return false
  if (rows.some((row) => row.blocked)) {
    strapi.log.info(`[fediverse] kept the blocked actor ${actorId}: only an admin lifts a block`)
    return false
  }

  // Rows blocked since the read stay: a delete never removes a block.
  return (await deleteUnblocked(strapi, rows)) > 0
}

/**
 * Whether an admin has blocked this remote actor; their activities are ignored.
 *
 * @remarks
 * True when any row of the actor is blocked, because duplicate rows are possible.
 *
 * @param site - The `documentId` of the site; the default site when omitted.
 */
export async function isActorBlocked(
  strapi: Core.Strapi,
  actorId: string,
  siteId?: string
): Promise<boolean> {
  const site = await resolveSite(strapi, siteId)
  return (await query(strapi).count({ where: { ...inSite(site), actorId, blocked: true } })) > 0
}

/** The actors with a blocked row: none of their rows counts as an active follower. */
async function blockedActorIds(strapi: Core.Strapi, site: string): Promise<string[]> {
  const rows = (await query(strapi).findMany({
    where: { ...inSite(site), blocked: true },
    select: ['actorId'],
  })) as Array<{ actorId: string }>
  return rows.map((row) => row.actorId).filter((actorId) => typeof actorId === 'string')
}

/** The `where` of a site's active followers (`blocked` false) or of the blocked ones (`blocked` true). */
async function followersWhere(strapi: Core.Strapi, site: string, blocked: boolean) {
  if (blocked) return { ...inSite(site), blocked: true }
  const excluded = await blockedActorIds(strapi, site)
  return excluded.length > 0
    ? { ...inSite(site), blocked: false, actorId: { $notIn: excluded } }
    : { ...inSite(site), blocked: false }
}

/**
 * Followers in the order they first followed.
 *
 * @param options - `blocked: true` lists the actors an admin has blocked
 * instead of the active followers; `site` is the `documentId` of the site (the default one when omitted).
 */
export async function listFollowers(
  strapi: Core.Strapi,
  options: { blocked?: boolean; site?: string } = {}
): Promise<FollowerRecord[]> {
  const blocked = options.blocked ?? false
  const rows = (await query(strapi).findMany({
    where: await followersWhere(strapi, await resolveSite(strapi, options.site), blocked),
    orderBy: { createdAt: 'asc' },
  })) as FollowerRow[]
  return rows.map(toRecord)
}

/**
 * Number of active followers.
 *
 * @param options - `blocked: true` counts the actors an admin has blocked
 * instead; `site` is the `documentId` of the site (the default one when omitted).
 */
export async function countFollowers(
  strapi: Core.Strapi,
  options: { blocked?: boolean; site?: string } = {}
): Promise<number> {
  const blocked = options.blocked ?? false
  return await query(strapi).count({
    where: await followersWhere(strapi, await resolveSite(strapi, options.site), blocked),
  })
}

/** Most followers the plugin page lists; a remote party can add rows, so the answer is bounded. */
export const FOLLOWER_ROWS_LIMIT = 500

/**
 * Followers and blocked actors of a site for the plugin page, newest first, up to
 * `FOLLOWER_ROWS_LIMIT`. The default site when `site` is omitted.
 */
export async function listFollowerRows(
  strapi: Core.Strapi,
  site?: string
): Promise<Array<FollowerRecord & { since: string }>> {
  const rows = (await query(strapi).findMany({
    where: inSite(await resolveSite(strapi, site)),
    orderBy: { createdAt: 'desc' },
    limit: FOLLOWER_ROWS_LIMIT,
  })) as Array<FollowerRow & { createdAt: string }>
  return rows.map((row) => ({ ...toRecord(row), since: row.createdAt }))
}

/**
 * Blocks or unblocks the remote actor of one follower row, from the plugin page.
 *
 * @remarks
 * Acts on every row of the actor, not on the one row: duplicate rows are possible
 * (risk 8 in `docs/architecture/federation.md`) and an actor with any blocked row counts as
 * blocked, so unblocking one row of two would leave it blocked. Unblocking keeps the row: the actor is an
 * active follower again, as if the admin had cleared the flag in the content manager.
 *
 * @param site - The `documentId` of the site; a row of another site is no such row. The default
 * site when omitted.
 * @returns `false` when there is no such row.
 */
export async function setActorBlocked(
  strapi: Core.Strapi,
  documentId: string,
  blocked: boolean,
  siteId?: string
): Promise<boolean> {
  const site = await resolveSite(strapi, siteId)
  const row = (await query(strapi).findOne({
    where: { ...inSite(site), documentId },
  })) as FollowerRow | null
  if (row == null) return false
  await query(strapi).updateMany({
    where: { ...inSite(site), actorId: row.actorId },
    data: { blocked },
  })
  return true
}

/**
 * Flags the followers delivered at `inbox` as unreachable, so fan-outs skip them.
 *
 * @remarks
 * Called when the inbox answered a permanent failure (`404` or `410`). A follower
 * already flagged keeps its original `unreachableSince`.
 *
 * @param site - The `documentId` of the site; the default site when omitted.
 * @returns How many followers were newly flagged.
 */
export async function markUnreachable(
  strapi: Core.Strapi,
  inbox: string,
  site?: string
): Promise<number> {
  const result = (await query(strapi).updateMany({
    where: { ...inSite(await resolveSite(strapi, site)), inbox, unreachableSince: { $null: true } },
    data: { unreachableSince: new Date().toISOString() },
  })) as { count: number }
  return result.count
}

/**
 * Clears the unreachable flag of a remote actor that has just sent us an activity,
 * which shows its server answers again.
 *
 * @param site - The `documentId` of the site; the default site when omitted.
 * @returns How many followers were cleared.
 */
export async function markReachable(
  strapi: Core.Strapi,
  actorId: string,
  site?: string
): Promise<number> {
  const result = (await query(strapi).updateMany({
    where: {
      ...inSite(await resolveSite(strapi, site)),
      actorId,
      unreachableSince: { $notNull: true },
    },
    data: { unreachableSince: null },
  })) as { count: number }
  return result.count
}

export default (): {
  isActorBlocked: typeof isActorBlocked
  recordFollower: typeof recordFollower
  removeFollower: typeof removeFollower
  listFollowers: typeof listFollowers
  countFollowers: typeof countFollowers
  markUnreachable: typeof markUnreachable
  listFollowerRows: typeof listFollowerRows
  setActorBlocked: typeof setActorBlocked
  markReachable: typeof markReachable
} => ({
  isActorBlocked,
  recordFollower,
  removeFollower,
  listFollowers,
  countFollowers,
  markUnreachable,
  listFollowerRows,
  setActorBlocked,
  markReachable,
})
