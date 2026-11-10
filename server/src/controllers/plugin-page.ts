import type { Core } from '@strapi/strapi'

import { PERMISSION_MANAGE, PERMISSION_READ } from '../constants/permissions'
import { ARTICLE_UID } from '../constants/uids'
import { getDefaultLocale } from '../services/articles'
import { runDiagnostics } from '../services/diagnostics'
import { listFailedRows } from '../services/federated-articles'
import { listFollowerRows, setActorBlocked } from '../services/followers'
import { retryFailedDelivery } from '../services/publisher'
import { siteOfRequest } from '../services/sites'
import type { FailureRow, FollowerRow, RetryResult } from '../types/plugin-page'
import { sendProblem, type ProblemContext } from '../utils/problem'

/** Most failed deliveries the page lists. */
const FAILURES_LIMIT = 50

interface Context extends ProblemContext {
  params: Record<string, string>
  query: Record<string, unknown>
  /** The admin's ability; a plugin permission has no subject, so `can` takes the action alone. */
  state: { userAbility?: { can(action: string): boolean } }
}

type Handler = (ctx: Context) => Promise<void>

/**
 * The admin page of the plugin: diagnostics, followers and failed deliveries. Reading needs the
 * plugin permission `read`, changing anything needs `manage`; both are checked on the admin's
 * ability, so a role without them gets a problem detail `403`.
 */
export default ({
  strapi,
}: {
  strapi: Core.Strapi
}): Record<'diagnostics' | 'followers' | 'block' | 'unblock' | 'failures' | 'retry', Handler> => {
  /** Whether the admin may do `permission`; answers the `403` itself when not. */
  function allowed(ctx: Context, permission: string): boolean {
    if (ctx.state.userAbility?.can(permission) === true) return true
    sendProblem(ctx, 403, 'forbidden', 'Your role may not use this part of the Fediverse page.')
    return false
  }

  /**
   * Titles of the articles in the default locale, the published one before the draft, which is
   * what an editor knows the article by. An article that no longer exists has none.
   */
  async function titlesOf(documentIds: string[]): Promise<Map<string, string | null>> {
    const titles = new Map<string, string | null>()
    if (documentIds.length === 0) return titles
    const articles = (await strapi.db.query(ARTICLE_UID).findMany({
      select: ['documentId', 'title', 'publishedAt'],
      where: { documentId: { $in: documentIds }, locale: await getDefaultLocale(strapi) },
    })) as Array<{ documentId: string; title: string | null; publishedAt: string | null }>
    for (const article of articles.filter((row) => row.publishedAt != null)) {
      titles.set(article.documentId, article.title)
    }
    for (const article of articles) {
      if (!titles.has(article.documentId)) titles.set(article.documentId, article.title)
    }
    return titles
  }

  /** The site the request is for (`?site=<slug>`, else the default one); answers `404` when unknown. */
  async function siteOf(ctx: Context): Promise<string | null> {
    const site = await siteOfRequest(strapi, ctx)
    if (site == null) sendProblem(ctx, 404, 'unknown-site', 'There is no such site.')
    return site
  }

  function setBlocked(blocked: boolean): Handler {
    return async (ctx) => {
      if (!allowed(ctx, PERMISSION_MANAGE)) return
      const site = await siteOf(ctx)
      if (site == null) return
      if (!(await setActorBlocked(strapi, ctx.params.documentId, blocked, site))) {
        sendProblem(ctx, 404, 'follower-not-found', 'There is no such follower.')
        return
      }
      ctx.body = { blocked }
    }
  }

  return {
    async diagnostics(ctx) {
      if (!allowed(ctx, PERMISSION_READ)) return
      const site = await siteOf(ctx)
      if (site == null) return
      ctx.body = { checks: await runDiagnostics(strapi, site) }
    },

    async followers(ctx) {
      if (!allowed(ctx, PERMISSION_READ)) return
      const site = await siteOf(ctx)
      if (site == null) return
      const rows = await listFollowerRows(strapi, site)
      const followers: FollowerRow[] = rows.map((row) => ({
        documentId: row.documentId,
        handle: row.handle,
        name: row.name,
        since: row.since,
        blocked: row.blocked,
        unreachableSince: row.unreachableSince,
      }))
      ctx.body = { followers }
    },

    block: setBlocked(true),
    unblock: setBlocked(false),

    async failures(ctx) {
      if (!allowed(ctx, PERMISSION_READ)) return
      const site = await siteOf(ctx)
      if (site == null) return
      const rows = await listFailedRows(strapi, FAILURES_LIMIT, site)
      const titles = await titlesOf(rows.map((row) => row.articleDocumentId))
      const failures: FailureRow[] = rows.map((row) => ({
        articleDocumentId: row.articleDocumentId,
        title: titles.get(row.articleDocumentId) ?? null,
        lastActivityType: row.lastActivityType,
        lastActivityAt: row.lastActivityAt,
        attempts: row.attempts,
        lastError: row.lastError,
      }))
      ctx.body = { failures }
    },

    async retry(ctx) {
      if (!allowed(ctx, PERMISSION_MANAGE)) return
      const site = await siteOf(ctx)
      if (site == null) return
      let outcome
      try {
        outcome = await retryFailedDelivery(strapi, ctx.params.documentId, site)
      } catch (error) {
        strapi.log.error(
          `[fediverse] retry for ${ctx.params.documentId} failed: ${error instanceof Error ? error.name : 'unknown error'}`
        )
        sendProblem(
          ctx,
          503,
          'queue-unavailable',
          'The activity could not be queued; try again in a moment.'
        )
        return
      }
      if (outcome.status === 'not-failed') {
        sendProblem(ctx, 409, 'not-failed', 'This article has no failed delivery to retry.')
        return
      }
      if (outcome.status === 'not-federable') {
        sendProblem(
          ctx,
          409,
          'article-not-published',
          'Only a published version with a title and slug can be federated.'
        )
        return
      }
      const result: RetryResult = {
        activity: outcome.type,
        queued: outcome.fanOut.queued,
        skipped: outcome.fanOut.skipped,
      }
      ctx.status = 202
      ctx.body = result
    },
  }
}
