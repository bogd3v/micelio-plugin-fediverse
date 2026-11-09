import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { Note } from '@fedify/fedify/vocab'
import request from 'supertest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { getPublicRole } from './helpers/permissions'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'

const ARTICLE_UID = 'api::article.article'
const COMMENT_UID = 'plugin::comments.comment'
const FOLLOWER_UID = 'plugin::fediverse.follower'
const ACTIVITY_JSON = 'application/activity+json'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const PASSWORD = 'Moderator-1'

type Json = Record<string, unknown>

/** A JSON-LD property that may be one value or a list, as a list. */
const asList = (value: unknown): unknown[] =>
  value == null ? [] : Array.isArray(value) ? value : [value]

describe('Fediverse moderator replies (comment → Note in the remote thread)', () => {
  let remote: RemoteActor
  let host: string
  let articleDocumentId: string
  let parentUri: string
  let moderatorId: number
  let plainAdminId: number
  let counter = 0

  const admin = () => strapi.plugin('comments').service('admin')
  const comments = () => strapi.db.query(COMMENT_UID)
  const deliveriesOf = (type: string) => remote.inboxDeliveries.filter((a) => a.type === type)
  const noteUrl = (documentId: string) => `http://${host}/fediverse/notes/${documentId}`
  const getNote = (documentId: string) =>
    request(strapi.server.httpServer)
      .get(`/fediverse/notes/${documentId}`)
      .set('Accept', ACTIVITY_JSON)
  const row = (id: number | string) => comments().findOne({ where: { id } })
  const noteUriOf = async (id: number | string) => (await row(id)).fediverseNoteUri ?? null

  async function adminUser(email: string, roleId: number): Promise<number> {
    const user = await strapi.service('admin::user').create({
      email,
      password: PASSWORD,
      firstname: 'Mod',
      lastname: 'Erator',
      isActive: true,
      roles: [roleId],
    })
    return Number(user.id)
  }

  /** A comment that arrived from the fediverse: the remote note and its author. */
  async function remoteComment(overrides: Json = {}) {
    counter += 1
    parentUri = `${remote.actorUrl}/statuses/${counter}`
    return strapi.documents(COMMENT_UID).create({
      data: {
        content: 'A question from Mastodon',
        related: `${ARTICLE_UID}:${articleDocumentId}`,
        approvalStatus: 'APPROVED',
        authorId: remote.actorUrl,
        authorName: 'Reader',
        fediverseUri: parentUri,
        fediverseActorHandle: '@reader@remote.example.test',
        ...overrides,
      },
    })
  }

  /** The moderator's reply, made the way the admin's moderation view makes it. */
  async function moderatorReplies(
    parentId: number | string,
    content = 'The moderator answers',
    authorId = moderatorId
  ) {
    return admin().postComment({
      id: Number(parentId),
      author: { id: authorId, email: 'mod@example.test', firstname: 'Mod', lastname: 'Erator' },
      content,
    })
  }

  /** Waits for the reply's Create, and for its note id to be stored. */
  async function federated(replyId: number | string) {
    await waitUntil(() => deliveriesOf('Create').length >= 1)
    await waitUntil(async () => (await noteUriOf(replyId)) != null)
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()
    host = serverHost()
    // The activity ids are built from Strapi's public URL, as in production.
    strapi.config.set('server.url', `http://${host}`)

    const publicRole = await getPublicRole()
    for (const action of ['findAll', 'findAllFlat', 'findAllInHierarchy']) {
      await strapi.query('plugin::users-permissions.permission').create({
        data: { action: `plugin::comments.client.${action}`, role: publicRole.id },
      })
    }
    await strapi.service('plugin::users-permissions.users-permissions').initialize()

    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    moderatorId = await adminUser('moderator@example.test', superAdmin.id)
    // The comments plugin checks no permission when an admin posts: this account has none.
    const noPermission = await strapi
      .service('admin::role')
      .create({ name: 'No comment rights', description: 'test' })
    plainAdminId = await adminUser('plain-admin@example.test', noPermission.id)

    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title: 'Reply target', slug: 'reply-target', description: 'x' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    articleDocumentId = draft.documentId
  })

  beforeEach(async () => {
    remote = await createRemoteActor({ preferredUsername: 'reader' })
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
    remote.inboxDeliveries.length = 0
  })

  afterEach(async () => {
    await remote.close()
    await strapi.db.query(FOLLOWER_UID).deleteMany({})
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await cleanupStrapi()
  })

  describe('what is sent', () => {
    it('sends a signed Create(Note) to the remote author, mentioning them, and stores the note id', async () => {
      const parent = await remoteComment()

      const reply = await moderatorReplies(parent.id, 'Fish & chips < 5\n\nSecond paragraph.')

      const create = await waitUntil(() => deliveriesOf('Create')[0])
      const note = create.object as Json
      expect(create.actor).toBe(`http://${host}/fediverse/user/devbog`)
      expect(note).toMatchObject({ type: 'Note', inReplyTo: parentUri })
      expect(note.id).toBe(noteUrl(reply.documentId))
      expect(asList(note.to)).toContain(remote.actorUrl)
      expect(asList(note.cc)).toEqual(
        expect.arrayContaining([PUBLIC, `http://${host}/fediverse/user/devbog/followers`])
      )
      // Escaped text, a paragraph per blank line: the moderator's text is never markup.
      expect(String(note.content)).toBe('<p>Fish &amp; chips &lt; 5</p><p>Second paragraph.</p>')
      expect(String(note.url)).toBe(
        `https://blog.example.test/blog/reply-target#comment-${reply.documentId}`
      )
      // A remote server notifies a person of a mention only.
      expect(asList(note.tag)).toEqual([
        expect.objectContaining({
          type: 'Mention',
          href: remote.actorUrl,
          name: '@reader@remote.example.test',
        }),
      ])
      // Signed by the actor key (Fedify's signer adds Signature, or Signature-Input for RFC 9421).
      const headers = remote.inboxRequests.find((r) =>
        r.body.includes(noteUrl(reply.documentId))
      )?.headers
      expect(headers?.get('signature') ?? headers?.get('signature-input')).toBeTruthy()

      await waitUntil(async () => (await noteUriOf(reply.id)) === noteUrl(reply.documentId))
    })

    it('delivers to the remote author with no followers, and once when the author also follows', async () => {
      // The author is a follower here: exactly one delivery to that inbox.
      const parent = await remoteComment()
      const first = await moderatorReplies(parent.id, 'To a follower who is also the author')
      await federated(first.id)
      expect(deliveriesOf('Create')).toHaveLength(1)

      // No followers at all: the author still gets it.
      remote.inboxDeliveries.length = 0
      await strapi.db.query(FOLLOWER_UID).deleteMany({})
      const second = await remoteComment()
      await moderatorReplies(second.id, 'To the author only')
      await waitUntil(() => deliveriesOf('Create').length === 1)
    })

    it('does not address a remote author that is blocked on this site', async () => {
      await strapi.db.query(FOLLOWER_UID).updateMany({
        where: { actorId: remote.actorUrl },
        data: { blocked: true },
      })
      const other = await createRemoteActor({ preferredUsername: 'bystander' })
      try {
        await strapi
          .plugin('fediverse')
          .service('followers')
          .recordFollower(strapi, { actorId: other.actorUrl, inbox: other.inboxUrl })
        const parent = await remoteComment()

        await moderatorReplies(parent.id)

        await waitUntil(() => other.inboxDeliveries.find((a) => a.type === 'Create'))
        expect(remote.inboxDeliveries).toHaveLength(0)
      } finally {
        await other.close()
      }
    })

    it('serves the note, and the public comments API shows the reply without a fediverse mark', async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id)
      await federated(reply.id)

      const served = await getNote(reply.documentId).expect(200)
      expect(served.body).toMatchObject({ type: 'Note', inReplyTo: parentUri })
      expect(served.headers['content-type']).toMatch(/activity\+json|ld\+json/)
      // Parses with Fedify's own vocabulary, which is what `npx @fedify/cli lookup` uses.
      const parsed = await Note.fromJsonLd(served.body)
      expect(parsed.id?.href).toBe(noteUrl(reply.documentId))
      expect(parsed.replyTargetId?.href).toBe(parentUri)
      expect(parsed.attributionId?.href).toBe(`http://${host}/fediverse/user/devbog`)

      // The frontend marks a comment as remote by its `fediverseUri` or its handle: the site's own
      // reply has neither, and its note id is not in the public response at all.
      const listed = await request(strapi.server.httpServer)
        .get(`/api/comments/${ARTICLE_UID}:${articleDocumentId}/flat`)
        .expect(200)
      const items: Array<Json> = Array.isArray(listed.body) ? listed.body : listed.body.data
      const shown = items.find((item) => item.id === reply.id)
      expect(shown).toMatchObject({ fediverseUri: null, fediverseActorHandle: null })
      expect(JSON.stringify(shown)).not.toContain('/fediverse/notes/')
    })

    it("lets a remote reply to the moderator's note nest under it", async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id)
      await federated(reply.id)

      const res = await remote.postSignedActivity(`http://${host}/fediverse/user/devbog/inbox`, {
        '@context': AS_CONTEXT,
        id: `${remote.actorUrl}/activities/answer-1`,
        type: 'Create',
        actor: remote.actorUrl,
        object: {
          id: `${remote.actorUrl}/statuses/answer-1`,
          type: 'Note',
          attributedTo: remote.actorUrl,
          inReplyTo: noteUrl(reply.documentId),
          content: '<p>Thanks for the answer</p>',
          to: [PUBLIC],
        },
      })
      expect(res.ok).toBe(true)

      const nested = await waitUntil(() =>
        comments().findOne({
          where: { fediverseUri: `${remote.actorUrl}/statuses/answer-1` },
          populate: { threadOf: true },
        })
      )
      expect(nested.threadOf?.id).toBe(reply.id)
    })
  })

  describe('what is not sent', () => {
    it("sends nothing for a reply to a local comment or a reader's reply to a fediverse comment", async () => {
      const local = await strapi.documents(COMMENT_UID).create({
        data: {
          content: 'A local comment',
          related: `${ARTICLE_UID}:${articleDocumentId}`,
          approvalStatus: 'APPROVED',
          authorId: 'guest',
          authorName: 'Guest',
        },
      })
      const fediverse = await remoteComment()

      const toLocal = await moderatorReplies(local.id, 'To a local comment')
      const byReader = await strapi
        .plugin('comments')
        .service('client')
        .create({
          relation: `${ARTICLE_UID}:${articleDocumentId}`,
          content: 'A reader replies',
          threadOf: fediverse.id,
          author: { id: 'reader-1', name: 'Reader', email: 'reader@example.test' },
        })
      // A reply that does federate comes after: when it arrives, the two before it were not sent.
      const sent = await moderatorReplies(fediverse.id, 'The one that federates')

      await waitUntil(() => deliveriesOf('Create').length === 1)
      expect(deliveriesOf('Create')[0].object).toMatchObject({ id: noteUrl(sent.documentId) })
      expect(await noteUriOf(toLocal.id)).toBeNull()
      expect(await noteUriOf(byReader.id)).toBeNull()
      await getNote(toLocal.documentId).expect(404)
    })

    it('does not let an admin account without the right to moderate comments speak as the blog', async () => {
      const parent = await remoteComment()
      const fromPlainAdmin = await moderatorReplies(
        parent.id,
        'From an account with no rights',
        plainAdminId
      )
      const fromModerator = await moderatorReplies(parent.id, 'From the moderator')

      await waitUntil(() => deliveriesOf('Create').length === 1)
      expect(deliveriesOf('Create')[0].object).toMatchObject({
        id: noteUrl(fromModerator.documentId),
      })
      expect(await noteUriOf(fromPlainAdmin.id)).toBeNull()
      await getNote(fromPlainAdmin.documentId).expect(404)
    })

    it('sends nothing for a reply to a comment that is not shown, or on an article that is not published', async () => {
      const pending = await remoteComment({ approvalStatus: 'PENDING' })
      const onPending = await moderatorReplies(pending.id, 'To a pending comment')
      const unpublished = await strapi
        .documents(ARTICLE_UID)
        .create({ data: { title: 'Not published', slug: 'not-published', description: 'x' } })
      const onDraft = await remoteComment({
        related: `${ARTICLE_UID}:${unpublished.documentId}`,
      })
      const toDraftArticle = await moderatorReplies(onDraft.id, 'On an unpublished article')
      const shown = await remoteComment()
      const sent = await moderatorReplies(shown.id, 'The one that federates')

      await waitUntil(() => deliveriesOf('Create').length === 1)
      expect(deliveriesOf('Create')[0].object).toMatchObject({ id: noteUrl(sent.documentId) })
      expect(await noteUriOf(onPending.id)).toBeNull()
      expect(await noteUriOf(toDraftArticle.id)).toBeNull()
    })

    it('answers 404 for a note that is not a moderator reply', async () => {
      const fediverse = await remoteComment()
      await getNote(fediverse.documentId).expect(404)
      await getNote('does-not-exist').expect(404)
    })
  })

  describe('edits and retractions', () => {
    it('sends an Update when the moderator edits the reply', async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id, 'First wording')
      await federated(reply.id)

      await admin().updateComment({ id: reply.id, content: 'Second wording' })

      const update = await waitUntil(() => deliveriesOf('Update')[0])
      expect(update.object).toMatchObject({ id: noteUrl(reply.documentId) })
      expect(String((update.object as Json).content)).toContain('Second wording')
      const served = await getNote(reply.documentId).expect(200)
      expect(String(served.body.content)).toContain('Second wording')
    })

    it('sends a Delete with a Tombstone when the reply is rejected, removed or blocked, and the note is a 404', async () => {
      for (const change of [{ approvalStatus: 'REJECTED' }, { removed: true }, { blocked: true }]) {
        remote.inboxDeliveries.length = 0
        const parent = await remoteComment()
        const reply = await moderatorReplies(parent.id)
        await federated(reply.id)
        await getNote(reply.documentId).expect(200)

        await comments().update({ where: { id: reply.id }, data: change })

        const del = await waitUntil(() => deliveriesOf('Delete')[0])
        expect(del.object).toMatchObject({ type: 'Tombstone', id: noteUrl(reply.documentId) })
        expect(asList(del.to)).toContain(remote.actorUrl)
        await getNote(reply.documentId).expect(404)
        // The identifier never changes: the note id stays after the Delete.
        expect(await noteUriOf(reply.id)).toBe(noteUrl(reply.documentId))
      }
    })

    it('retracts replies hidden by a write that names no comment: a blocked thread, or a removal of many', async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id)
      await federated(reply.id)

      // What `blockCommentThread` does to the comments under a blocked one.
      await comments().updateMany({ where: { id: reply.id }, data: { blockedThread: true } })

      await waitUntil(() => deliveriesOf('Delete').length === 1)
      await getNote(reply.documentId).expect(404)

      remote.inboxDeliveries.length = 0
      const second = await remoteComment()
      const other = await moderatorReplies(second.id)
      await federated(other.id)
      // What the plugin does to every comment of an article that is deleted.
      await comments().updateMany({ where: { id: other.id }, data: { removed: true } })
      await waitUntil(() => deliveriesOf('Delete').length === 1)
    })

    it('retracts a reply whose row is deleted outright', async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id)
      await federated(reply.id)

      await comments().delete({ where: { id: reply.id } })

      const del = await waitUntil(() => deliveriesOf('Delete')[0])
      expect(del.object).toMatchObject({ type: 'Tombstone', id: noteUrl(reply.documentId) })
    })

    it('sends a Create again when a reply sent back to moderation is approved, with an id of its own', async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id)
      await federated(reply.id)
      await comments().update({ where: { id: reply.id }, data: { approvalStatus: 'PENDING' } })
      await waitUntil(() => deliveriesOf('Delete').length === 1)

      await comments().update({ where: { id: reply.id }, data: { approvalStatus: 'APPROVED' } })

      await waitUntil(() => deliveriesOf('Create').length === 2)
      const ids = deliveriesOf('Create').map((activity) => activity.id)
      expect(new Set(ids).size).toBe(2)
      await getNote(reply.documentId).expect(200)
    })

    it('sends nothing twice: a write that changes nothing visible, or the same state again', async () => {
      const parent = await remoteComment()
      const reply = await moderatorReplies(parent.id)
      await federated(reply.id)

      await comments().update({ where: { id: reply.id }, data: { blocked: false } })
      await comments().update({ where: { id: reply.id }, data: { approvalStatus: 'APPROVED' } })
      // A write that changes the text is the one that does send, which marks the end of the others.
      await admin().updateComment({ id: reply.id, content: 'Edited once' })

      await waitUntil(() => deliveriesOf('Update').length === 1)
      expect(deliveriesOf('Create')).toHaveLength(1)
      expect(deliveriesOf('Delete')).toHaveLength(0)
    })
  })
})
