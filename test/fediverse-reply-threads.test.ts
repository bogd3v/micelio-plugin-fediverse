import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { MAX_THREAD_DEPTH, THREAD_TIME_BUDGET_MS } from '../server/src/constants/replies'

const ARTICLE_UID = 'api::article.article'
const COMMENT_UID = 'plugin::comments.comment'
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

interface ThreadNote {
  inReplyTo: string | null
  content: string
  attributedTo?: string
  to?: string
  /** The id the note claims, when it is not the URL it is served at. */
  id?: string
}

describe('Fediverse federation: reply threads deeper than one hop (#302)', () => {
  let host: string
  let inboxUrl: string
  let remotes: RemoteActor[] = []
  let noteCounter = 0

  const articleUri = (documentId: string) => `http://${host}/fediverse/articles/${documentId}`
  const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  async function publishedArticle() {
    const title = `Thread target ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const draft = await strapi
      .documents(ARTICLE_UID)
      .create({ data: { title, slug: slugify(title), description: 'Excerpt.' } })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })
    return draft
  }

  async function newRemote() {
    const remote = await createRemoteActor({
      preferredUsername: `threader${remotes.length}`,
      name: `Thread Reader ${remotes.length}`,
    })
    remotes.push(remote)
    return remote
  }

  /** Serves a note on `remote`'s server, written by `remote` unless said otherwise, and returns its URL. */
  function serveNote(
    remote: RemoteActor,
    { inReplyTo, content, attributedTo, to, id }: ThreadNote
  ) {
    noteCounter += 1
    const path = `/notes/${noteCounter}`
    const url = new URL(path, remote.actorUrl).href
    remote.serve(path, {
      '@context': AS_CONTEXT,
      id: id ?? url,
      type: 'Note',
      attributedTo: attributedTo ?? remote.actorUrl,
      ...(inReplyTo ? { inReplyTo } : {}),
      content,
      to: to ?? PUBLIC,
    })
    return url
  }

  /** Delivers a `Create(Note)` from `remote` that replies to `inReplyTo`; returns the note id. */
  async function deliverReply(remote: RemoteActor, inReplyTo: string, content = '<p>leaf</p>') {
    noteCounter += 1
    const noteId = `${remote.actorUrl}/notes/delivered-${noteCounter}`
    const res = await remote.postSignedActivity(inboxUrl, {
      '@context': AS_CONTEXT,
      id: `${noteId}/activity`,
      type: 'Create',
      actor: remote.actorUrl,
      object: {
        id: noteId,
        type: 'Note',
        attributedTo: remote.actorUrl,
        inReplyTo,
        content,
        to: PUBLIC,
      },
    })
    expect(res.ok).toBe(true)
    return noteId
  }

  const findComment = (fediverseUri: string) =>
    strapi.documents(COMMENT_UID).findFirst({ filters: { fediverseUri }, populate: ['threadOf'] })

  const noteGets = (remote: RemoteActor) =>
    remote.getRequests.filter((path) => path.startsWith('/notes/'))

  async function block(remote: RemoteActor) {
    await strapi.plugin('fediverse').service('followers').recordFollower(strapi, {
      actorId: remote.actorUrl,
      inbox: remote.inboxUrl,
    })
    await strapi.db
      .query('plugin::fediverse.follower')
      .update({ where: { actorId: remote.actorUrl }, data: { blocked: true } })
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.FRONTEND_ARTICLE_PATH = '/blog/{slug}'
    await setupStrapi()

    host = serverHost()
    inboxUrl = `http://${host}/fediverse/user/devbog/inbox`
  })

  afterEach(async () => {
    await Promise.all(remotes.map((remote) => remote.close()))
    remotes = []
    await strapi.db.query('plugin::fediverse.follower').deleteMany({})
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  it('stores a three-level remote thread ending at our article, nested and PENDING', async () => {
    const article = await publishedArticle()
    const [top, middle, leaf] = [await newRemote(), await newRemote(), await newRemote()]

    const topNote = serveNote(top, {
      inReplyTo: articleUri(article.documentId),
      content: '<p>top <script>alert(1)</script>&amp; more</p>',
    })
    const middleNote = serveNote(middle, { inReplyTo: topNote, content: '<p>middle</p>' })
    const leafNote = await deliverReply(leaf, middleNote)

    const leafComment = await waitUntil(() => findComment(leafNote))
    const middleComment = await findComment(middleNote)
    const topComment = await findComment(topNote)

    expect(topComment?.threadOf ?? null).toBeNull()
    expect(middleComment?.threadOf?.documentId).toBe(topComment?.documentId)
    expect(leafComment.threadOf?.documentId).toBe(middleComment?.documentId)
    for (const comment of [topComment, middleComment, leafComment]) {
      expect(comment?.approvalStatus).toBe('PENDING')
      expect(comment?.related).toBe(`${ARTICLE_UID}:${article.documentId}`)
      expect(comment?.isAdminComment).toBeFalsy()
    }
    // The fetched notes get the sanitization and the author of a delivered one.
    expect(topComment?.content).toBe('top alert(1)& more')
    expect(topComment?.authorId).toBe(top.actorUrl)
    expect(topComment?.authorName).toBe('Thread Reader 0')
    expect(topComment?.fediverseActorHandle).toMatch(/^@threader0@/)
    expect(middleComment?.authorId).toBe(middle.actorUrl)
  })

  it('nests a deep reply under a comment that is already stored', async () => {
    const article = await publishedArticle()
    const [first, second, third] = [await newRemote(), await newRemote(), await newRemote()]

    const storedNote = await deliverReply(first, articleUri(article.documentId), '<p>stored</p>')
    const stored = await waitUntil(() => findComment(storedNote))
    const missingNote = serveNote(second, { inReplyTo: storedNote, content: '<p>missed</p>' })
    const leafNote = await deliverReply(third, missingNote)

    const leaf = await waitUntil(() => findComment(leafNote))
    const missing = await findComment(missingNote)
    expect(missing?.threadOf?.documentId).toBe(stored.documentId)
    expect(leaf.threadOf?.documentId).toBe(missing?.documentId)
  })

  it(`stops after ${MAX_THREAD_DEPTH} fetches and stores nothing when the chain never reaches us`, async () => {
    const remote = await newRemote()
    const sender = await newRemote()

    let parent = 'https://elsewhere.example/notes/root'
    const chain: string[] = []
    for (let i = 0; i < MAX_THREAD_DEPTH + 2; i++) {
      parent = serveNote(remote, { inReplyTo: parent, content: `<p>link ${i}</p>` })
      chain.push(parent)
    }
    const leafNote = await deliverReply(sender, parent)

    expect(noteGets(remote)).toHaveLength(MAX_THREAD_DEPTH)
    for (const uri of [...chain, leafNote]) expect(await findComment(uri)).toBeNull()
  })

  it('stores nothing when the chain ends at a post that answers nothing', async () => {
    const remote = await newRemote()
    const sender = await newRemote()
    const rootNote = serveNote(remote, { inReplyTo: null, content: '<p>own thread</p>' })
    const middleNote = serveNote(remote, { inReplyTo: rootNote, content: '<p>middle</p>' })
    const leafNote = await deliverReply(sender, middleNote)

    expect(noteGets(remote)).toHaveLength(2)
    for (const uri of [rootNote, middleNote, leafNote]) expect(await findComment(uri)).toBeNull()
  })

  it(`ends a cycle after ${MAX_THREAD_DEPTH} fetches and stores nothing`, async () => {
    const remote = await newRemote()
    const sender = await newRemote()
    const [first, second] = ['/notes/cycle-a', '/notes/cycle-b'].map(
      (path) => new URL(path, remote.actorUrl).href
    )
    for (const [id, inReplyTo] of [
      [first, second],
      [second, first],
    ]) {
      remote.serve(new URL(id).pathname, {
        '@context': AS_CONTEXT,
        id,
        type: 'Note',
        attributedTo: remote.actorUrl,
        inReplyTo,
        content: '<p>round</p>',
        to: PUBLIC,
      })
    }
    const leafNote = await deliverReply(sender, first)

    expect(noteGets(remote)).toHaveLength(MAX_THREAD_DEPTH)
    for (const uri of [first, second, leafNote]) expect(await findComment(uri)).toBeNull()
  })

  it('stops the branch at a parent that is empty once sanitized, keeping the notes above it', async () => {
    const article = await publishedArticle()
    const [top, empty, leaf] = [await newRemote(), await newRemote(), await newRemote()]
    const topNote = serveNote(top, {
      inReplyTo: articleUri(article.documentId),
      content: '<p>top</p>',
    })
    // An image-only post: nothing is left of its content as plain text.
    const emptyNote = serveNote(empty, { inReplyTo: topNote, content: '<p><br></p>' })
    const leafNote = await deliverReply(leaf, emptyNote)

    await waitUntil(() => findComment(topNote))
    expect(await findComment(emptyNote)).toBeNull()
    expect(await findComment(leafNote)).toBeNull()
  })

  it('stops the branch at a blocked actor and keeps the notes above it', async () => {
    const article = await publishedArticle()
    const [top, blocked, leaf] = [await newRemote(), await newRemote(), await newRemote()]
    await block(blocked)

    const topNote = serveNote(top, {
      inReplyTo: articleUri(article.documentId),
      content: '<p>top</p>',
    })
    const blockedNote = serveNote(blocked, { inReplyTo: topNote, content: '<p>blocked</p>' })
    const leafNote = await deliverReply(leaf, blockedNote)

    const topComment = await waitUntil(() => findComment(topNote))
    expect(topComment.approvalStatus).toBe('PENDING')
    expect(await findComment(blockedNote)).toBeNull()
    expect(await findComment(leafNote)).toBeNull()
  })

  it.each([
    [
      'its author is on another origin than the server that served it',
      { attributedTo: 'https://other.example/users/victim' },
    ],
    ['it is not addressed to the public', { to: 'https://remote.example/followers' }],
    [
      'its id is on another host than the URL it was fetched from',
      { id: 'https://other.example/notes/borrowed' },
    ],
  ])('drops the chain when a fetched note fails the checks: %s', async (_label, overrides) => {
    const article = await publishedArticle()
    const [middle, leaf] = [await newRemote(), await newRemote()]
    const middleNote = serveNote(middle, {
      inReplyTo: articleUri(article.documentId),
      content: '<p>middle</p>',
      ...overrides,
    })
    const leafNote = await deliverReply(leaf, middleNote)

    expect(await findComment(middleNote)).toBeNull()
    expect(await findComment(leafNote)).toBeNull()
  })

  it('answers the inbox within the time budget when a remote server never answers', async () => {
    const stalled = await newRemote()
    const sender = await newRemote()
    const silentNote = stalled.hang('/notes/silent')

    const started = Date.now()
    const leafNote = await deliverReply(sender, silentNote)
    const elapsed = Date.now() - started

    expect(noteGets(stalled)).toEqual(['/notes/silent'])
    expect(elapsed).toBeLessThan(THREAD_TIME_BUDGET_MS + 2_000)
    expect(await findComment(leafNote)).toBeNull()
  })
})
