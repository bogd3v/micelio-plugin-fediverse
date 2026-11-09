import type { Core } from '@strapi/strapi'
import type { KvStore, MessageQueue, RetryPolicy } from '@fedify/fedify'

import type { DeliveryObservation } from './delivery'

/** Data Fedify hands to every dispatcher and listener. */
export type FediverseContextData = {
  strapi: Core.Strapi
}

/** Where Fedify keeps its caches and queues its outgoing deliveries. */
export interface FederationBackend {
  /** `postgres` shares the database Strapi runs on; `memory` is lost on restart. */
  kind: 'postgres' | 'memory'
  kv: KvStore
  /** The raw queue; the caller wraps it to observe deliveries. */
  queue: MessageQueue
  /** Closes the pool Fedify opened, if any. Safe to call twice. */
  close(): Promise<void>
}

/** What Fedify's `origin` option takes: the web origin alone, or the handle host split from it. */
export type FederationOriginOption = string | { handleHost: string; webOrigin: string }

/** What `createFediverseFederation` needs besides the dispatchers it registers itself. */
export interface FederationSetup {
  /** Receives failed outbox deliveries, with the activity id Fedify's own LogTape line leaves out. */
  log?: Pick<Core.Strapi['log'], 'error'>
  /** Fixed public origin for every id Fedify builds, with the handle host when it differs; without it the origin comes from the request. */
  origin?: FederationOriginOption
  /** Where Fedify keeps its caches and queues outgoing deliveries. */
  backend: FederationBackend
  /** The raw `ENCRYPTION_KEY`, or `null`; read on every queued message. */
  encryptionKey(): string | null
  /** Reports a queued message that could not be decrypted; must not throw. */
  onUnreadable(error: unknown): void
  /** Writes what a queued delivery left behind; must not throw. */
  settle(observation: DeliveryObservation): Promise<void>
  /**
   * Replaces Fedify's default retry policy; read on every failed attempt.
   * Registered as `plugin::fediverse.outboxRetryPolicy` so a test can shorten the delays.
   */
  retryPolicy?(): RetryPolicy | undefined
}
