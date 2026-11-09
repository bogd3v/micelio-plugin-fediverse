import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createExponentialBackoffPolicy } from '@fedify/fedify'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import type followers from '../server/src/services/followers'

const ARTICLE_UID = 'api::article.article'
const ROW_UID = 'plugin::fediverse.federated-article'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'
/** Text a failing inbox puts in its answer; it must reach neither the row nor the log. */
const REMOTE_BODY = 'REMOTE-BODY-MUST-NOT-LEAK'

interface Row {
  status: string
  lastActivityType: string | null
  attempts: number
  lastError: string | null
}

interface FollowerRow {
  unreachableSince: string | null
}

describe('Fediverse federation (delivery queue)', () => {
  let followersService: ReturnType<typeof followers>
  let remote: RemoteActor
  let host: string

  const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const rowOf = async (articleDocumentId: string) =>
    (await strapi.db.query(ROW_UID).findOne({ where: { articleDocumentId } })) as Row | null
  const followerRow = async () =>
    (await strapi.db
      .query(FOLLOWER_UID)
      .findOne({ where: { actorId: remote.actorUrl } })) as FollowerRow
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)

  /** Two quick retries instead of Fedify's hours-long backoff. */
  const retryQuickly = (maxAttempts: number) =>
    strapi.config.set(
      'plugin::fediverse.outboxRetryPolicy',
      createExponentialBackoffPolicy({
        initialDelay: { milliseconds: 20 },
        maxAttempts,
        jitter: false,
      })
    )

  async function publishArticle() {
    const title = `Queued article ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title, slug: slugify(title), description: 'A short excerpt.' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    return draft.documentId
  }

  /** Every line the plugin wrote to the log while `run` ran, at any level. */
  async function captureLog(run: (lines: string[]) => Promise<void>): Promise<string[]> {
    const lines: string[] = []
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(strapi.log, level).mockImplementation(((message: unknown) => {
        lines.push(String(message))
        return strapi.log
      }) as never)
    )
    try {
      await run(lines)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    return lines
  }

  async function startRemote(options: Parameters<typeof createRemoteActor>[0] = {}) {
    remote = await createRemoteActor({ preferredUsername: 'reader', ...options })
    await followersService.recordFollower(strapi, {
      actorId: remote.actorUrl,
      inbox: remote.inboxUrl,
    })
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()
    host = serverHost()
    followersService = strapi.plugin('fediverse').service('followers')
  })

  afterEach(async () => {
    strapi.config.set('plugin::fediverse.outboxRetryPolicy', undefined)
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  afterAll(async () => {
    // In-flight fan-out runs after the document operation commits.
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await strapi.db.query(ROW_UID).deleteMany({})
    await cleanupStrapi()
  })

  describe('retries', () => {
    beforeEach(async () => {
      await startRemote({ inboxFailures: { status: 500, times: 3, body: REMOTE_BODY } })
    })

    it('delivers exactly once to an inbox that answers 500 three times, and the row never fails', async () => {
      retryQuickly(10)

      const log = await captureLog(async () => {
        const documentId = await publishArticle()
        await waitUntil(() => deliveriesOf('Create').length === 1)

        // The failure is settled into the row after Fedify has handled the message. The first
        // attempt used two POSTs (a refused delivery is knocked twice), the second one's first
        // POST was the third refusal and its second knock was accepted.
        const row = await waitUntil(async () => {
          const current = await rowOf(documentId)
          return current != null && current.attempts >= 2 ? current : null
        })
        expect(remote.inboxAttempts).toBe(4)
        expect(deliveriesOf('Create')).toHaveLength(1)
        expect(row.status).toBe('created')
        expect(row.attempts).toBe(2)
        expect(row.lastError).toContain('answered HTTP 500')
        expect(row.lastError).not.toContain(REMOTE_BODY)
      })

      // Three failed attempts of one activity are one line, and it never carries the answer.
      const failureLines = log.filter((line) => line.startsWith('[fediverse] delivery of'))
      expect(failureLines).toHaveLength(1)
      expect(failureLines[0]).toContain('HTTP 500')
      expect(log.some((line) => line.includes(REMOTE_BODY))).toBe(false)
    })
  })

  describe('abandoned delivery', () => {
    it('leaves the row failed with the attempts and a sanitized reason when the inbox never answers', async () => {
      await startRemote({ inboxFailures: { status: 500, times: Infinity, body: REMOTE_BODY } })
      retryQuickly(2)

      const documentId = await publishArticle()
      const failed = await waitUntil(async () => {
        const current = await rowOf(documentId)
        return current?.status === 'failed' ? current : null
      })

      expect(failed.lastActivityType).toBe('Create')
      expect(failed.attempts).toBe(3)
      expect(remote.inboxAttempts).toBe(6)
      expect(deliveriesOf('Create')).toHaveLength(0)
      expect(failed.lastError).toContain('answered HTTP 500')
      expect(failed.lastError).not.toContain(REMOTE_BODY)
      expect(failed.lastError).not.toMatch(/127\.0\.0\.1/)
      // A server that is only failing is retried, not written off.
      expect((await followerRow()).unreachableSince).toBeNull()
    })
  })

  describe('unreachable followers', () => {
    it('skips a follower whose inbox is gone, until it sends an activity again', async () => {
      // Both knocks of the first attempt are answered 410; later deliveries are accepted.
      await startRemote({ inboxFailures: { status: 410, times: 2 } })

      const first = await publishArticle()
      const failed = await waitUntil(async () => {
        const current = await rowOf(first)
        return current?.status === 'failed' ? current : null
      })
      expect(failed.attempts).toBe(1)
      const flagged = await waitUntil(async () => (await followerRow()).unreachableSince)
      expect(new Date(flagged).getTime()).toBeLessThanOrEqual(Date.now())
      expect(remote.inboxAttempts).toBe(2)

      // The next fan-out leaves it out.
      const log = await captureLog(async (lines) => {
        await publishArticle()
        await waitUntil(() => lines.some((line) => line.includes('nothing queued')))
      })
      expect(remote.inboxAttempts).toBe(2)
      expect(log.some((line) => line.includes('no reachable followers, nothing queued'))).toBe(true)

      // The followers collection still lists it.
      const collection = await fetch(`http://${host}/fediverse/user/devbog/followers`, {
        headers: { accept: 'application/activity+json' },
      })
      expect(((await collection.json()) as { totalItems: number }).totalItems).toBe(1)

      // Any activity from it clears the flag; the 410 answered once, so this delivery lands.
      const article = await publishedArticleUri()
      const like = await remote.postSignedActivity(`http://${host}/fediverse/inbox`, {
        '@context': AS_CONTEXT,
        id: `${remote.actorUrl}/activities/Like-1`,
        type: 'Like',
        actor: remote.actorUrl,
        object: article,
      })
      expect(like.ok).toBe(true)
      await waitUntil(async () => (await followerRow()).unreachableSince === null)

      await publishArticle()
      await waitUntil(() => deliveriesOf('Create').length === 1)
      expect(remote.inboxAttempts).toBe(3)
    })
  })

  async function publishedArticleUri(): Promise<string> {
    const documentId = await publishArticle()
    return `http://${host}/fediverse/articles/${documentId}`
  }
})
