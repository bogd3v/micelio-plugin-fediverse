import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import type { TrackedLifecycleEvent } from '../server/src/types/lifecycle'

/** A WebFinger JRD link. */
type JrdLink = { rel: string; type?: string; href: string }

const ACTIVITY_JSON = 'application/activity+json'

const followActivity = (id: string, actor: string, object: string) => ({
  '@context': 'https://www.w3.org/ns/activitystreams',
  id,
  type: 'Follow',
  actor,
  object,
})

describe('Fediverse federation (Phase 0 spike)', () => {
  let host: string
  let actorUrl: string

  beforeAll(async () => {
    // Enable the fediverse plugin before Strapi boots (the plugin reads it when it loads, `server/src/utils/federation-enabled.ts`).
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    await setupStrapi()
    await setFediverseUsername('bogdev')

    host = serverHost()
    actorUrl = `http://${host}/fediverse/user/devbog`
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  it('exposes the plugin and its lifecycle service', () => {
    expect(strapi.plugin('fediverse')).toBeTruthy()
    expect(typeof strapi.plugin('fediverse').service('lifecycle').getEvents).toBe('function')
  })

  it('GET /.well-known/webfinger resolves the blog handle to the actor', async () => {
    const res = await request(strapi.server.httpServer)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:bogdev@${host}` })
      .expect(200)
      .expect('Content-Type', /json/)

    expect(res.body.subject).toBe(`acct:bogdev@${host}`)
    const selfLink = (res.body.links as JrdLink[]).find((link) => link.rel === 'self')
    expect(selfLink?.type).toBe(ACTIVITY_JSON)
    // The handle changed from @devbog; the actor URI (and its followers) did not.
    expect(selfLink?.href.endsWith('/fediverse/user/devbog')).toBe(true)
  })

  it('GET /.well-known/webfinger still resolves the former handle to the same actor', async () => {
    const res = await request(strapi.server.httpServer)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:devbog@${host}` })
      .expect(200)

    const selfLink = (res.body.links as JrdLink[]).find((link) => link.rel === 'self')
    expect(selfLink?.href.endsWith('/fediverse/user/devbog')).toBe(true)
  })

  it('GET /.well-known/webfinger does not resolve other usernames', async () => {
    await request(strapi.server.httpServer)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:someone@${host}` })
      .expect(404)
  })

  it('GET /fediverse/user/devbog serves an ActivityPub Person document', async () => {
    const res = await request(strapi.server.httpServer)
      .get('/fediverse/user/devbog')
      .set('Accept', ACTIVITY_JSON)
      .expect(200)

    expect(res.body.type).toBe('Person')
    expect(res.body.id.endsWith('/fediverse/user/devbog')).toBe(true)
    expect(res.body.preferredUsername).toBe('bogdev')
    expect(res.body.inbox.endsWith('/fediverse/user/devbog/inbox')).toBe(true)
    // The actor must advertise a verification key (Mastodon requirement).
    const keys = res.body.assertionMethod ?? res.body.publicKey
    expect(keys).toBeTruthy()
  })

  it('content-negotiates: HTML requests fall through to Strapi (404)', async () => {
    await request(strapi.server.httpServer)
      .get('/fediverse/user/devbog')
      .set('Accept', 'text/html')
      .expect(404)
  })

  it('returns 404 for unknown actors', async () => {
    await request(strapi.server.httpServer)
      .get('/fediverse/user/nobody')
      .set('Accept', ACTIVITY_JSON)
      .expect(404)
  })

  it('rejects unsigned inbox deliveries before any listener runs (401)', async () => {
    await request(strapi.server.httpServer)
      .post('/fediverse/user/devbog/inbox')
      .set('Content-Type', ACTIVITY_JSON)
      .send(
        followActivity(
          'https://mastodon.social/tests/fediverse/1',
          'https://mastodon.social/users/test',
          actorUrl
        )
      )
      .expect(401)
  })

  it('does not stall large request bodies on routes that are not its own', async () => {
    // @fedify/koa consumes the request stream of every non-GET request; with the
    // middleware mounted ahead of the body parser, bodies over roughly 16-64 KB
    // used to hang forever (publishing a long article in the admin did).
    const big = { email: 'x'.repeat(512 * 1024), password: 'not-a-real-password' }

    const res = await request(strapi.server.httpServer)
      .post('/admin/login')
      .set('Content-Type', 'application/json')
      .send(big)
      .timeout({ response: 8000, deadline: 12000 })

    // The status is Strapi's own business (this endpoint answers 500 even with
    // the plugin off); what matters is that it answered instead of waiting for
    // a body that never arrives.
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('leaves regular Strapi endpoints unaffected', async () => {
    await request(strapi.server.httpServer).get('/_health').expect(204)
  })

  it('receives article publish/unpublish lifecycle events', async () => {
    const lifecycle = strapi.plugin('fediverse').service('lifecycle')
    lifecycle.clear()

    // Strapi emits entry.* events asynchronously, after the document
    // operation's transaction commits (in a follow-up transaction). Poll
    // instead of reading the recorded events synchronously.
    const waitForEvent = async (action: string, documentId: string) => {
      const deadline = Date.now() + 5000
      for (;;) {
        const found = lifecycle
          .getEvents()
          .find(
            (event: TrackedLifecycleEvent) =>
              event.action === action && event.documentId === documentId
          )
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${action} event (article ${documentId})`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    const draft = await strapi.documents('api::article.article').create({
      data: {
        title: 'Fediverse spike article',
        description: 'Verifies publish lifecycles reach the plugin',
      },
    })

    const published = await strapi
      .documents('api::article.article')
      .publish({ documentId: draft.documentId })

    const publishEvent = await waitForEvent('entry.publish', published.documentId)
    expect(publishEvent.uid).toBe('api::article.article')

    await strapi.documents('api::article.article').unpublish({ documentId: draft.documentId })

    await waitForEvent('entry.unpublish', draft.documentId)

    // Let the delete's own entry.delete emission flush so the test harness
    // can destroy the DB pool without aborting it mid-transaction.
    const deleteEmitted = new Promise<void>((resolve) => {
      const off = strapi.eventHub.on(
        'entry.delete',
        async (payload: { uid?: string } | undefined) => {
          if (payload?.uid === 'api::article.article') {
            off()
            resolve()
          }
        }
      )
    })
    await strapi.documents('api::article.article').delete({ documentId: draft.documentId })
    await deleteEmitted
  })
})
