import type {
  ExportEntry,
  ExtensionSite,
  SectionImportReport,
} from '@micelio/strapi-plugin-core/strapi-server'
import type { Core } from '@strapi/strapi'

import {
  EXPORT_FOLLOWERS_PATH,
  EXPORT_MAX_FOLLOWERS,
  EXPORT_VERSION,
  EXTENSION_ID,
} from '../constants/extensions'
import { PERMISSION_MANAGE } from '../constants/permissions'
import { FOLLOWER_UID } from '../constants/uids'
import { extensionsOf } from '../utils/core-extensions'
import { cleanRemoteText } from '../utils/remote-text'
import { safeRemoteUrl } from '../utils/remote-url'
import { inSite, siteRowId } from './sites'

/** Longest value of a string column (Strapi's default for `string`). */
const COLUMN_LENGTH = 255

/**
 * A follower as the archive holds it: the minimum that restores the follower or its block. No
 * avatar, no unreachable flag, no date and no key: the new site learns them again.
 */
export interface ArchivedFollower {
  actorId: string
  handle: string | null
  name: string | null
  inbox: string | null
  blocked: boolean
}

interface FollowerRow {
  documentId: string
  actorId: string
  handle: string | null
  name: string | null
  inbox: string | null
  blocked: boolean | null
}

function query(strapi: Core.Strapi) {
  return strapi.db.query(FOLLOWER_UID)
}

/** The followers of a site, blocked ones included, oldest first. */
async function* followersOf(strapi: Core.Strapi, site: ExtensionSite): AsyncIterable<ExportEntry> {
  const rows = (await query(strapi).findMany({
    where: inSite(site.documentId),
    select: ['actorId', 'handle', 'name', 'inbox', 'blocked'],
    orderBy: { id: 'asc' },
  })) as FollowerRow[]
  const followers: ArchivedFollower[] = rows.map((row) => ({
    actorId: row.actorId,
    handle: row.handle ?? null,
    name: row.name ?? null,
    inbox: row.inbox ?? null,
    blocked: row.blocked === true,
  }))
  yield { path: EXPORT_FOLLOWERS_PATH, body: JSON.stringify({ followers }) }
}

/** An entry of the archive made safe to store, or `null` when it is not a follower to keep. */
function toArchived(value: unknown): ArchivedFollower | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  const actorId = safeRemoteUrl(entry.actorId, COLUMN_LENGTH)
  if (actorId == null || typeof entry.blocked !== 'boolean') return null
  return {
    actorId,
    handle: cleanRemoteText(entry.handle, COLUMN_LENGTH),
    name: cleanRemoteText(entry.name, COLUMN_LENGTH),
    inbox: safeRemoteUrl(entry.inbox, COLUMN_LENGTH),
    blocked: entry.blocked,
  }
}

/** The followers of the archive's file; it throws when the file is not the format of this section. */
function parseFollowers(entries: ExportEntry[]): unknown[] {
  const file = entries.find((entry) => entry.path === EXPORT_FOLLOWERS_PATH)
  if (file == null) return []
  const parsed = JSON.parse(Buffer.from(file.body).toString('utf8')) as { followers?: unknown }
  if (!Array.isArray(parsed.followers) || parsed.followers.length > EXPORT_MAX_FOLLOWERS) {
    throw new Error(`${EXPORT_FOLLOWERS_PATH} does not hold a list of followers`)
  }
  return parsed.followers
}

/**
 * Upserts the followers of the archive into a site, by `actorId`, in the transaction of the import.
 *
 * @remarks
 * A block is never lifted: an actor the site already blocks stays blocked whatever the archive
 * says. An entry that is not a follower (no usable `actorId`, no boolean `blocked`) is skipped;
 * the other fields are cleaned as when they come from a remote server.
 */
export async function importFollowers(
  strapi: Core.Strapi,
  site: ExtensionSite,
  entries: ExportEntry[]
): Promise<SectionImportReport> {
  const report: SectionImportReport = { imported: 0, skipped: 0 }
  const seen = new Set<string>()
  const where = inSite(site.documentId)
  for (const value of parseFollowers(entries)) {
    const follower = toArchived(value)
    if (follower == null || seen.has(follower.actorId)) {
      report.skipped += 1
      continue
    }
    seen.add(follower.actorId)
    const [existing] = (await query(strapi).findMany({
      where: { ...where, actorId: follower.actorId },
      orderBy: { id: 'asc' },
    })) as FollowerRow[]
    if (existing == null) {
      await query(strapi).create({
        data: { ...follower, avatar: null, site: await siteRowId(strapi, site.documentId) },
      })
    } else {
      await query(strapi).update({
        where: { documentId: existing.documentId },
        data: {
          // What the archive lacks never wipes what the target has (a working inbox).
          handle: follower.handle ?? existing.handle,
          name: follower.name ?? existing.name,
          inbox: follower.inbox ?? existing.inbox,
          blocked: existing.blocked === true || follower.blocked,
        },
      })
      if (follower.blocked) {
        await query(strapi).updateMany({
          where: { ...where, actorId: follower.actorId },
          data: { blocked: true },
        })
      }
    }
    report.imported += 1
  }
  return report
}

/** Registers the section with the core. Called from `register()`. */
export function registerExportSection(strapi: Core.Strapi): void {
  extensionsOf(strapi).registerExportSection({
    id: EXTENSION_ID,
    version: EXPORT_VERSION,
    personalData: true,
    permission: PERMISSION_MANAGE,
    write: (site) => followersOf(strapi, site),
    read: (site, entries) => importFollowers(strapi, site, entries),
  })
}
