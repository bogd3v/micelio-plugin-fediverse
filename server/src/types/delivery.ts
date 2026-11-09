/** What the plugin learns about the delivery of one queued activity to one inbox. */

import type { RetryPolicy } from '@fedify/fedify'
import type { Activity } from '@fedify/fedify/vocab'

/** The retry policy's answer: the delay before the next attempt, or `null` when it gives up. */
export type RetryDelay = ReturnType<RetryPolicy>

/** An outbox message as the plugin reads it: the fields that identify the delivery. */
export interface OutboxMessageSummary {
  /** The id of the activity being delivered. */
  activityId?: string
  /** The inbox the message is addressed to. */
  inbox: string
  /** Attempts already made before this one; the first attempt is 0. */
  attempt: number
}

/**
 * Facts collected while Fedify handles one outbox message, written by Fedify's
 * callbacks and read when the message has been handled.
 *
 * @remarks
 * A message that leaves no failure behind was accepted by the inbox, or was only
 * a fan-out; Fedify has no callback that says so, so nothing is recorded for it.
 */
export interface DeliveryObservation {
  message: OutboxMessageSummary
  /** The last attempt failed with this error (`onOutboxError`). */
  failure?: { error: Error; activity: Activity | null }
  /** What the retry policy answered after the failure. */
  retry?: RetryDelay
  /** Fedify gave up: the inbox answered a permanent status, or a held activity expired. */
  permanent?: { reason: 'http' | 'circuit-breaker-ttl'; error: Error }
}
