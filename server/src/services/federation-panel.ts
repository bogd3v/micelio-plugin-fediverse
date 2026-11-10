import type { Core } from '@strapi/strapi'

import type { ArticleFederation } from '../types/federation-panel'
import { findPublishedArticle, getDefaultLocale } from './articles'
import { findFederatedArticle } from './federated-articles'
import { countInteractions } from './interactions'
import { replyCountsByStatus } from './stats'

/**
 * Why "Federate now" is not available for an article, or `null` when it is: only the default
 * locale federates, and only a published version with a title and slug has anything to send.
 */
export async function federateBlocker(
  strapi: Core.Strapi,
  documentId: string,
  locale: string
): Promise<'locale-not-federated' | 'article-not-published' | null> {
  if (locale !== (await getDefaultLocale(strapi))) return 'locale-not-federated'
  return (await findPublishedArticle(strapi, documentId)) == null ? 'article-not-published' : null
}

/**
 * The federation state of one article for the admin panel: the row of its last activity, the
 * fediverse counts and whether it can be federated now.
 *
 * @param locale - The locale the editor has open.
 * @param site - The `documentId` of the site; the default site when omitted.
 */
export async function describeFederation(
  strapi: Core.Strapi,
  documentId: string,
  locale: string,
  site?: string
): Promise<ArticleFederation> {
  const [row, interactions, replies, blocker] = await Promise.all([
    findFederatedArticle(strapi, documentId, site),
    countInteractions(strapi, documentId, site),
    replyCountsByStatus(strapi, documentId, site),
    federateBlocker(strapi, documentId, locale),
  ])

  return {
    documentId,
    state: row?.status ?? 'never',
    lastActivityType: row?.lastActivityType ?? null,
    lastActivityAt: row?.lastActivityAt ?? null,
    createSentAt: row?.createSentAt ?? null,
    attempts: row?.attempts ?? 0,
    lastError: row?.lastError ?? null,
    counts: {
      likes: interactions.likes,
      boosts: interactions.boosts,
      repliesApproved: replies.approved,
      repliesPending: replies.pending,
    },
    canFederate: blocker ? { allowed: false, code: blocker } : { allowed: true },
  }
}
