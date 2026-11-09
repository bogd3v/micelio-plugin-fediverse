import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { UID } from '@strapi/strapi'
import request from 'supertest'
import { setupStrapi, cleanupStrapi } from './strapi'

const ARTICLE_UID = 'api::article.article'
const COMMENT_UID = 'plugin::comments.comment'
const ACTIVITY_JSON = 'application/activity+json'

describe('Fediverse federation disabled (FEDIVERSE_ENABLED=false)', () => {
  beforeAll(async () => {
    // The plugin ships switched off (config/plugins.ts: FEDIVERSE_ENABLED defaults
    // to false). Production runs like this until it is deliberately enabled. Read
    // when Strapi loads its config, so it is set before booting.
    process.env.FEDIVERSE_ENABLED = 'false'
    await setupStrapi()
  })

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await cleanupStrapi()
  })

  it('does not load the plugin or its content types', () => {
    expect(strapi.plugin('fediverse')).toBeUndefined()
    // Not in the generated types, which describe the app with the plugin off.
    expect(strapi.contentType('plugin::fediverse.follower' as UID.ContentType)).toBeUndefined()
    expect(strapi.contentType('plugin::fediverse.interaction' as UID.ContentType)).toBeUndefined()
    expect(
      strapi.contentType('plugin::fediverse.federated-article' as UID.ContentType)
    ).toBeUndefined()
  })

  it.each([
    ['/.well-known/webfinger?resource=acct:devbog@localhost'],
    ['/fediverse/user/devbog'],
    ['/fediverse/user/devbog/outbox'],
    ['/nodeinfo/2.1'],
    ['/api/fediverse/articles/anything/stats'],
    ['/api/fediverse/articles/stats?documentIds=anything'],
    ['/api/fediverse/articles/ranking'],
    // The article panel's admin routes, which have a prefix of their own.
    ['/fediverse-panel/articles/anything/federation'],
    ['/fediverse/notes/anything'],
    ['/fediverse-panel/diagnostics'],
    ['/fediverse-panel/followers'],
    ['/fediverse-panel/failures'],
  ])('serves nothing at %s', async (path) => {
    await request(strapi.server.httpServer).get(path).set('Accept', ACTIVITY_JSON).expect(404)
  })

  it('has no federate route either', async () => {
    // Strapi's catch-all answers a POST to an unknown path with 404 or 405; what matters
    // is that it is neither the 202 of the route nor the 401 of its admin policy.
    const res = await request(strapi.server.httpServer).post(
      '/fediverse-panel/articles/anything/federate'
    )
    expect([404, 405]).toContain(res.status)
  })

  it('leaves the rest of the app working, including article publishing', async () => {
    await request(strapi.server.httpServer).get('/_health').expect(204)

    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title: 'No federation here', slug: 'no-federation-here' } })
    await expect(
      strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    ).resolves.toBeTruthy()
  })

  it('still hides pending comments from the public API', async () => {
    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title: 'Comment target', slug: 'comment-target' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    const relation = `${ARTICLE_UID}:${draft.documentId}`

    const publicRole = await strapi
      .query('plugin::users-permissions.role')
      .findOne({ where: { type: 'public' } })
    await strapi.query('plugin::users-permissions.permission').create({
      data: { action: 'plugin::comments.client.findAllFlat', role: publicRole.id },
    })
    await strapi.service('plugin::users-permissions.users-permissions').initialize()

    for (const [content, approvalStatus] of [
      ['visible comment', 'APPROVED'],
      ['pending comment', 'PENDING'],
      ['rejected comment', 'REJECTED'],
    ] as const) {
      await strapi
        .documents(COMMENT_UID)
        .create({ data: { content, related: relation, approvalStatus } })
    }

    const res = await request(strapi.server.httpServer)
      .get(`/api/comments/${relation}/flat`)
      .expect(200)

    const contents = (res.body.data as { content: string }[]).map((comment) => comment.content)
    expect(contents).toEqual(['visible comment'])
  })
})
