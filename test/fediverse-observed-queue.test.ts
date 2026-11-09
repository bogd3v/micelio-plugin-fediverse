import { describe, it, expect } from 'vitest'
import { InProcessMessageQueue, type MessageQueue } from '@fedify/fedify'
import { waitUntil } from './helpers/wait-until'
import { createFederationBackend, postgresOptions } from '../server/src/utils/federation-backend'
import { currentObservation, ObservedMessageQueue } from '../server/src/utils/observed-queue'
import type { DeliveryObservation } from '../server/src/types/delivery'

const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef'
const PRIVATE_JWK = { kty: 'RSA', n: 'public-part', d: 'PRIVATE-EXPONENT-MUST-NOT-BE-STORED' }

function outboxMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'outbox',
    id: 'message-1',
    activityId: 'https://blog.example.test/fediverse/articles/a1#create',
    inbox: 'https://remote.example.test/inbox',
    attempt: 0,
    keys: [
      { keyId: 'https://blog.example.test/fediverse/user/blog#main-key', privateKey: PRIVATE_JWK },
    ],
    ...overrides,
  }
}

/** An in-process queue that remembers what it was given, as a database would store it. */
function recordingQueue() {
  const inner = new InProcessMessageQueue()
  const stored: unknown[] = []
  const queue: MessageQueue = {
    enqueue: (message, options) => {
      stored.push(message)
      return inner.enqueue(message, options)
    },
    listen: (handler, options) => inner.listen(handler, options),
  }
  return { queue, stored }
}

/** Listens until `until` is true, then stops the worker. */
async function listenUntil(queue: MessageQueue, handler: (message: unknown) => Promise<void>) {
  const stop = new AbortController()
  const running = queue.listen(handler, { signal: stop.signal })
  return {
    async stop() {
      stop.abort()
      await running
    },
  }
}

describe('ObservedMessageQueue', () => {
  it('stores the private key of an outbox message encrypted and hands it back in clear', async () => {
    const { queue: inner, stored } = recordingQueue()
    const queue = new ObservedMessageQueue(inner, {
      encryptionKey: () => ENCRYPTION_KEY,
      settle: async () => {},
      onUnreadable: () => {},
    })
    const received: unknown[] = []

    await queue.enqueue(outboxMessage())
    const worker = await listenUntil(queue, async (message) => void received.push(message))
    await waitUntil(() => received.length === 1)
    await worker.stop()

    expect(JSON.stringify(stored)).not.toContain('PRIVATE-EXPONENT')
    expect(JSON.stringify(stored)).not.toContain('"kty"')
    expect(received[0]).toMatchObject({ keys: [{ privateKey: PRIVATE_JWK }] })
  })

  it('encrypts the key of a fan-out message too, which a send to five or more inboxes queues first', async () => {
    const { queue: inner, stored } = recordingQueue()
    const queue = new ObservedMessageQueue(inner, {
      encryptionKey: () => ENCRYPTION_KEY,
      settle: async () => {},
      onUnreadable: () => {},
    })
    const received: unknown[] = []

    await queue.enqueue({ type: 'fanout', id: 'f1', keys: outboxMessage().keys })
    const worker = await listenUntil(queue, async (message) => void received.push(message))
    await waitUntil(() => received.length === 1)
    await worker.stop()

    expect(JSON.stringify(stored)).not.toContain('PRIVATE-EXPONENT')
    expect(received[0]).toMatchObject({ type: 'fanout', keys: [{ privateKey: PRIVATE_JWK }] })
  })

  it('drops a message it cannot decrypt, reports it and goes on with the next', async () => {
    const { queue: inner } = recordingQueue()
    const sealed = new ObservedMessageQueue(inner, {
      encryptionKey: () => ENCRYPTION_KEY,
      settle: async () => {},
      onUnreadable: () => {},
    })
    const unreadable: unknown[] = []
    const reader = new ObservedMessageQueue(inner, {
      encryptionKey: () => 'a-different-encryption-key-0000000',
      settle: async () => {},
      onUnreadable: (error) => void unreadable.push(error),
    })
    const received: unknown[] = []

    await sealed.enqueue(outboxMessage())
    await sealed.enqueue({ type: 'fanout', id: 'plain' })
    const worker = await listenUntil(reader, async (message) => void received.push(message))
    await waitUntil(() => received.length === 1)
    await worker.stop()

    expect(unreadable).toHaveLength(1)
    expect(received).toEqual([{ type: 'fanout', id: 'plain' }])
  })

  it('passes a message through untouched when no ENCRYPTION_KEY is configured', async () => {
    const { queue: inner, stored } = recordingQueue()
    const queue = new ObservedMessageQueue(inner, {
      encryptionKey: () => null,
      settle: async () => {},
      onUnreadable: () => {},
    })

    await queue.enqueue(outboxMessage())

    expect(stored[0]).toEqual(outboxMessage())
  })

  it('reads a message queued before encryption was on, and leaves other message types alone', async () => {
    const { queue: inner } = recordingQueue()
    const queue = new ObservedMessageQueue(inner, {
      encryptionKey: () => ENCRYPTION_KEY,
      settle: async () => {},
      onUnreadable: () => {},
    })
    const received: unknown[] = []
    const fanout = { type: 'fanout', id: 'f1', keys: 'not-touched' }

    await inner.enqueue(outboxMessage())
    await queue.enqueue(fanout)
    const worker = await listenUntil(queue, async (message) => void received.push(message))
    await waitUntil(() => received.length === 2)
    await worker.stop()

    expect(received[0]).toMatchObject({ keys: [{ privateKey: PRIVATE_JWK }] })
    expect(received[1]).toEqual(fanout)
  })

  it('runs the handler of an outbox message inside an observation and settles it afterwards', async () => {
    const { queue: inner } = recordingQueue()
    const settled: DeliveryObservation[] = []
    const queue = new ObservedMessageQueue(inner, {
      encryptionKey: () => null,
      settle: async (observation) => void settled.push(observation),
      onUnreadable: () => {},
    })
    const seen: Array<DeliveryObservation | undefined> = []

    await queue.enqueue(outboxMessage({ attempt: 2 }))
    await queue.enqueue({ type: 'fanout', id: 'f1' })
    const worker = await listenUntil(queue, async () => {
      seen.push(currentObservation())
      const observation = currentObservation()
      if (observation) observation.failure = { error: new Error('refused'), activity: null }
    })
    await waitUntil(() => seen.length === 2)
    await waitUntil(() => settled.length === 1)
    await worker.stop()

    // A fan-out is not a delivery: it has no observation and settles nothing.
    expect(seen.map((observation) => observation?.message.attempt)).toEqual([2, undefined])
    expect(settled).toHaveLength(1)
    expect(settled[0].failure?.error.message).toBe('refused')
    expect(currentObservation()).toBeUndefined()
  })

  it('settles the observation even when the handler throws', async () => {
    const { queue: inner } = recordingQueue()
    const settled: DeliveryObservation[] = []
    const queue = new ObservedMessageQueue(inner, {
      encryptionKey: () => null,
      settle: async (observation) => void settled.push(observation),
      onUnreadable: () => {},
    })

    await queue.enqueue(outboxMessage())
    const running = queue.listen(async () => {
      throw new Error('handler failed')
    })

    await expect(running).rejects.toThrow('handler failed')
    expect(settled).toHaveLength(1)
  })
})

describe('postgresOptions', () => {
  const options = (connectionString: string, ssl?: unknown) =>
    postgresOptions({ connectionString, ssl: ssl as never }).ssl

  it('verifies the server certificate for the sslmodes that pg verifies', () => {
    for (const mode of ['require', 'prefer', 'verify-ca', 'verify-full']) {
      expect(options(`postgres://u:p@db.example.test/app?sslmode=${mode}`)).toEqual({
        rejectUnauthorized: true,
      })
    }
  })

  it('skips verification only for no-verify, and asks for TLS by nothing else', () => {
    expect(options('postgres://u:p@db.example.test/app?sslmode=no-verify')).toEqual({
      rejectUnauthorized: false,
    })
    expect(options('postgres://u:p@db.example.test/app?sslmode=disable')).toBeUndefined()
    expect(options('postgres://u:p@db.example.test/app')).toBeUndefined()
  })

  it("follows Strapi's DATABASE_SSL settings over the connection string", () => {
    expect(
      options('postgres://u:p@db.example.test/app?sslmode=no-verify', {
        rejectUnauthorized: true,
        ca: 'CA',
      })
    ).toEqual({ rejectUnauthorized: true, ca: 'CA' })
  })
})

describe('createFederationBackend', () => {
  const strapiWith = (connection: unknown) =>
    ({
      config: { get: (key: string) => (key === 'database.connection' ? connection : undefined) },
    }) as never

  it('keeps the key-value store and the queue in memory on SQLite', async () => {
    const backend = createFederationBackend(
      strapiWith({ client: 'sqlite', connection: { filename: '.tmp/data.db' } })
    )

    expect(backend.kind).toBe('memory')
    await backend.close()
  })

  it('uses PostgreSQL when Strapi does, without connecting until the first query', async () => {
    const backend = createFederationBackend(
      strapiWith({
        client: 'postgres',
        connection: { connectionString: 'postgres://user:pass@127.0.0.1:1/none', schema: 'public' },
      })
    )

    expect(backend.kind).toBe('postgres')
    await backend.close()
    await backend.close()
  })
})
