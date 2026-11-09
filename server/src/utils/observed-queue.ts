import { AsyncLocalStorage } from 'node:async_hooks'

import type {
  MessageQueue,
  MessageQueueDepth,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from '@fedify/fedify'

import type { DeliveryObservation, OutboxMessageSummary } from '../types/delivery'
import { decryptText, encryptText, isEncryptedEnvelope } from './key-encryption'

/** The outbox message fields this module reads; Fedify's own type is not exported whole. */
interface OutboxMessage {
  type: 'outbox'
  activityId?: string
  inbox: string
  attempt: number
  keys: Array<{ keyId: string; privateKey: unknown }>
}

/** What an {@link ObservedMessageQueue} needs from the plugin. */
export interface ObservedQueueOptions {
  /** The raw `ENCRYPTION_KEY`, or `null` when it is not configured (development, tests). */
  encryptionKey(): string | null
  /**
   * Called with the error when a queued message cannot be decrypted (the `ENCRYPTION_KEY`
   * changed). The message is dropped: the queue has already removed it.
   */
  onUnreadable(error: unknown): void
  /** Receives what was seen while one outbox message was handled; must not throw. */
  settle(observation: DeliveryObservation): Promise<void>
}

const observations = new AsyncLocalStorage<DeliveryObservation>()

/**
 * The observation of the outbox message being handled right now, or `undefined`
 * outside one (a fan-out, an inbox listener, a test calling Fedify directly).
 * Fedify's callbacks write into it.
 */
export function currentObservation(): DeliveryObservation | undefined {
  return observations.getStore()
}

function isOutboxMessage(value: unknown): value is OutboxMessage {
  if (value == null || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (
    message.type === 'outbox' &&
    typeof message.inbox === 'string' &&
    typeof message.attempt === 'number' &&
    Array.isArray(message.keys)
  )
}

/** Any message that carries signing keys: an outbox message, or the fan-out that creates them. */
function hasKeys(value: unknown): value is { keys: Array<{ keyId: string; privateKey: unknown }> } {
  return (
    value != null &&
    typeof value === 'object' &&
    Array.isArray((value as { keys?: unknown }).keys) &&
    (value as { keys: unknown[] }).keys.every(
      (pair) => pair != null && typeof pair === 'object' && 'privateKey' in pair
    )
  )
}

function summarize(message: OutboxMessage): OutboxMessageSummary {
  return { activityId: message.activityId, inbox: message.inbox, attempt: message.attempt }
}

/** Encrypts the actor's private key in a queued message, which Fedify writes as a plain JWK (outbox and fan-out messages alike: a send to five or more inboxes is fanned out first). */
function seal(message: unknown, encryptionKey: string | null): unknown {
  if (encryptionKey == null || !hasKeys(message)) return message
  return {
    ...message,
    keys: message.keys.map((pair) => ({
      ...pair,
      privateKey: isEncryptedEnvelope(pair.privateKey)
        ? pair.privateKey
        : encryptText(JSON.stringify(pair.privateKey), encryptionKey),
    })),
  }
}

/** Undoes {@link seal}; a message queued before encryption, or without a key, passes through. */
function open(message: unknown, encryptionKey: string | null): unknown {
  if (!hasKeys(message)) return message
  return {
    ...message,
    keys: message.keys.map((pair) =>
      isEncryptedEnvelope(pair.privateKey)
        ? { ...pair, privateKey: JSON.parse(decryptText(pair.privateKey, encryptionKey)) }
        : pair
    ),
  }
}

/**
 * A message queue that wraps another to do two things Fedify's queues do not.
 *
 * @remarks
 * It keeps the actor's private key out of the queue's storage in clear: Fedify
 * puts the signing key into every outbox message as a JWK, and on PostgreSQL
 * the message waits in a table, sometimes for the half hour of retries, so the key is
 * encrypted with `ENCRYPTION_KEY` (the scheme of the stored actor key) on the
 * way in and decrypted on the way out. And it runs each outbox message inside
 * an {@link currentObservation}, then hands what Fedify's callbacks recorded to
 * `settle`, which is how a failed delivery reaches the article's row: Fedify
 * reports attempts, permanent failures and the retry policy's answer only
 * through separate callbacks that do not know about one another.
 */
export class ObservedMessageQueue implements MessageQueue {
  readonly nativeRetrial?: boolean
  readonly atomicEnqueueMany?: boolean
  readonly enqueueMany?: MessageQueue['enqueueMany']
  readonly getDepth?: () => Promise<MessageQueueDepth>

  constructor(
    private readonly inner: MessageQueue,
    private readonly options: ObservedQueueOptions
  ) {
    this.nativeRetrial = inner.nativeRetrial
    this.atomicEnqueueMany = inner.atomicEnqueueMany
    if (inner.enqueueMany != null) {
      const enqueueMany = inner.enqueueMany.bind(inner)
      this.enqueueMany = (messages, enqueueOptions) =>
        enqueueMany(
          messages.map((message) => seal(message, this.options.encryptionKey())),
          enqueueOptions
        )
    }
    if (inner.getDepth != null) this.getDepth = inner.getDepth.bind(inner)
  }

  enqueue(message: unknown, options?: MessageQueueEnqueueOptions): Promise<void> {
    return this.inner.enqueue(seal(message, this.options.encryptionKey()), options)
  }

  listen(
    handler: (message: unknown) => Promise<void> | void,
    options?: MessageQueueListenOptions
  ): Promise<void> {
    return this.inner.listen(async (stored) => {
      let message: unknown
      try {
        message = open(stored, this.options.encryptionKey())
      } catch (error) {
        this.options.onUnreadable(error)
        return
      }
      if (!isOutboxMessage(message)) {
        await handler(message)
        return
      }
      const observation: DeliveryObservation = { message: summarize(message) }
      try {
        await observations.run(observation, async () => {
          await handler(message)
        })
      } finally {
        await this.options.settle(observation)
      }
    }, options)
  }
}
