import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { waitUntil } from './helpers/wait-until'
import { createFederationBackend } from '../server/src/utils/federation-backend'
import { ObservedMessageQueue } from '../server/src/utils/observed-queue'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef'
const PRIVATE_JWK = { kty: 'RSA', n: 'public-part', d: 'PRIVATE-EXPONENT-MUST-NOT-BE-STORED' }
const TABLES = ['fedify_message_v2', 'fedify_kv_v2']

// Needs a Postgres server: TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres
;(TEST_DATABASE_URL ? describe : describe.skip)('Fediverse delivery queue on PostgreSQL', () => {
  const strapiFor = () =>
    ({
      config: {
        get: (key: string) =>
          key === 'database.connection'
            ? { client: 'postgres', connection: { connectionString: TEST_DATABASE_URL } }
            : undefined,
      },
    }) as never

  async function sql<T = unknown>(text: string): Promise<T[]> {
    const client = new Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      return (await client.query(text)).rows as T[]
    } finally {
      await client.end()
    }
  }

  const dropTables = () => sql(`DROP TABLE IF EXISTS ${TABLES.join(', ')}`)

  function observedQueue() {
    const backend = createFederationBackend(strapiFor())
    const queue = new ObservedMessageQueue(backend.queue, {
      encryptionKey: () => ENCRYPTION_KEY,
      settle: async () => {},
      onUnreadable: () => {},
    })
    return { backend, queue }
  }

  beforeAll(dropTables)
  afterAll(dropTables)

  it('keeps an enqueued message across a restart and delivers it once, with the key encrypted at rest', async () => {
    const before = observedQueue()
    expect(before.backend.kind).toBe('postgres')
    await before.queue.enqueue({
      type: 'outbox',
      id: 'restart-1',
      activityId: 'https://blog.example.test/fediverse/articles/a1#create',
      inbox: 'https://remote.example.test/inbox',
      attempt: 0,
      keys: [{ keyId: 'https://blog.example.test/k', privateKey: PRIVATE_JWK }],
    })

    // What a database dump or a backup would contain while the delivery waits.
    const [row] = await sql<{ message: string }>(
      `SELECT message::text AS message FROM fedify_message_v2`
    )
    expect(row.message).not.toContain('PRIVATE-EXPONENT')
    expect(row.message).not.toContain('"kty"')

    // The process dies before any worker took the message.
    await before.backend.close()

    const after = observedQueue()
    const received: unknown[] = []
    const stop = new AbortController()
    const running = after.queue.listen(async (message) => void received.push(message), {
      signal: stop.signal,
    })
    await waitUntil(() => received.length === 1, { timeoutMs: 15000 })
    // Give a second delivery the chance to show up before asserting there is none.
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    stop.abort()
    await running
    await after.backend.close()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ id: 'restart-1', keys: [{ privateKey: PRIVATE_JWK }] })
    expect(await sql(`SELECT 1 FROM fedify_message_v2`)).toHaveLength(0)
  })
})
