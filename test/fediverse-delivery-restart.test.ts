import { describe, it, expect, afterAll } from 'vitest'
import { createExponentialBackoffPolicy } from '@fedify/fedify'
import { Client } from 'pg'
import { setupStrapi, cleanupStrapi } from './strapi'
import { createRemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'

const ARTICLE_UID = 'api::article.article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const ROW_UID = 'plugin::fediverse.federated-article'

// Needs a Postgres server: TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres
;(process.env.TEST_DATABASE_URL ? describe : describe.skip)(
  'Fediverse delivery queue (restart on PostgreSQL)',
  () => {
    /** Messages waiting in the queue table of this worker's database. */
    async function queuedMessages(): Promise<number> {
      const url = new URL(process.env.TEST_DATABASE_URL as string)
      url.pathname = `/strapi_test_${process.env.JEST_WORKER_ID || '1'}`
      const client = new Client({ connectionString: url.href })
      await client.connect()
      try {
        const result = await client.query('SELECT count(*)::int AS n FROM fedify_message_v2')
        return result.rows[0].n as number
      } finally {
        await client.end()
      }
    }

    afterAll(async () => {
      await cleanupStrapi()
    })

    it('delivers a retry that was waiting in the queue when Strapi stopped', async () => {
      process.env.FEDIVERSE_ENABLED = 'true'
      process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
      process.env.FRONTEND_URL = 'https://blog.example.test'
      process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
      // Both knocks of the first attempt are refused, so Fedify queues a retry (1 to 2 s later).
      const remote = await createRemoteActor({
        preferredUsername: 'reader',
        inboxFailures: { status: 503, times: 2 },
      })

      try {
        await setupStrapi()
        await strapi
          .plugin('fediverse')
          .service('followers')
          .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
        const title = `Restart article ${Date.now()}`
        const draft = await strapi.documents(ARTICLE_UID).create({
          data: { title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: 'x' },
        })
        await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
        // Fixed 5 s delay, long enough for the stop below to come first.
        strapi.config.set(
          'plugin::fediverse.outboxRetryPolicy',
          createExponentialBackoffPolicy({
            initialDelay: { seconds: 5 },
            maxDelay: { seconds: 5 },
            factor: 1,
            jitter: false,
          })
        )
        await waitUntil(() => remote.inboxAttempts === 2)
        expect(remote.inboxDeliveries).toHaveLength(0)
        // The failure is handled once Fedify has queued the retry.
        await waitUntil(async () => (await queuedMessages()) === 1)

        // Stop before the retry is due; it is only a row in the queue table now.
        await cleanupStrapi()
        expect(await queuedMessages()).toBe(1)
        expect(remote.inboxDeliveries).toHaveLength(0)
        await setupStrapi({ keepDatabase: true })

        await waitUntil(() => remote.inboxDeliveries.length === 1, { timeoutMs: 20000 })
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
        expect(remote.inboxDeliveries).toHaveLength(1)
        expect(remote.inboxDeliveries[0].type).toBe('Create')
        expect(remote.inboxAttempts).toBe(3)

        const row = await strapi.db
          .query(ROW_UID)
          .findOne({ where: { articleDocumentId: draft.documentId } })
        expect(row.status).toBe('created')
        await strapi.db.query(FOLLOWER_UID).deleteMany({})
      } finally {
        await remote.close()
      }
    })
  }
)
