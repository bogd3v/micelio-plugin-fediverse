import type { Core } from '@strapi/strapi'

import type { DeliveryObservation } from '../types/delivery'
import { parseArticleActivityId } from './articles'
import { recordDeliveryFailure } from './federated-articles'
import { markUnreachable } from './followers'

/**
 * Writes what one queued delivery left behind: the article's row and, for an
 * inbox that is gone, the follower.
 *
 * @remarks
 * Called once per outbox message, after Fedify has handled it. A message that
 * recorded no failure is ignored. A failure that will be retried raises
 * `attempts` and sets `lastError`. A failure Fedify gives up on (the retry
 * policy answered `null`, or the inbox answered `404`/`410`) also turns the row
 * `failed`, and a `404`/`410` flags the followers at that inbox unreachable.
 * Never throws: a database error is logged, because it must not make Fedify
 * think the delivery itself failed.
 */
export async function settleDelivery(
  strapi: Core.Strapi,
  observation: DeliveryObservation
): Promise<void> {
  const { message, failure, permanent, retry } = observation
  const error =
    permanent?.reason === 'circuit-breaker-ttl'
      ? new Error('Delivery was held by the circuit breaker until it expired, and dropped')
      : (permanent?.error ?? failure?.error)
  if (error == null) return

  try {
    const abandoned = permanent != null || retry === null
    const failedAttempt = message.attempt + 1
    const activity = parseArticleActivityId(message.activityId)
    if (activity != null) {
      await recordDeliveryFailure(strapi, activity.documentId, activity.type, {
        attempts: abandoned ? failedAttempt : failedAttempt + 1,
        abandoned,
        error,
      })
    }
    if (permanent?.reason === 'http') {
      const flagged = await markUnreachable(strapi, message.inbox)
      if (flagged > 0) {
        strapi.log.warn(
          `[fediverse] ${flagged} follower${flagged === 1 ? '' : 's'} marked unreachable: their inbox no longer exists`
        )
      }
    }
  } catch (settleError) {
    strapi.log.error(
      `[fediverse] could not record a failed delivery: ${settleError instanceof Error ? settleError.name : 'unknown error'}`
    )
  }
}
