import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor } from './helpers/remote-actor'
import { defaultSiteRelation } from './helpers/categories'
import { waitUntil } from './helpers/wait-until'
import { updateDefaultSite, writeFediverseProfile } from './helpers/fediverse-profile'
import type { Modules } from '@strapi/strapi'
import type followers from '../server/src/services/followers'

const ACTIVITY_JSON = 'application/activity+json'

/** The fields of the actor document these tests check. */
interface ActorDocument {
  id: string
  preferredUsername: string
  inbox: string
  name: string
  summary: string
  url: string
  discoverable: boolean
  icon: { url: string }
  image: { url: string }
  attachment: { type: string; name: string; value: string }[]
  assertionMethod?: { publicKeyMultibase?: string }[]
  publicKey?: { publicKeyPem?: string }
}

async function writeGlobal(data: Modules.Documents.Params.Data.Input<'api::global.global'>) {
  const existing = await strapi.documents('api::global.global').findFirst()
  if (existing) {
    return strapi.documents('api::global.global').update({ documentId: existing.documentId, data })
  }
  return strapi.documents('api::global.global').create({ data })
}

async function createImage(name: string): Promise<{ id: number }> {
  return strapi.db.query('plugin::upload.file').create({
    data: {
      name,
      hash: name.replace(/\W/g, '_'),
      ext: '.png',
      mime: 'image/png',
      size: 1,
      url: `/uploads/${name}`,
      provider: 'local',
    },
  })
}

async function clearFollowers() {
  const rows = await strapi.db.query('plugin::fediverse.follower').findMany()
  for (const row of rows) {
    await strapi.db
      .query('plugin::fediverse.follower')
      .delete({ where: { documentId: row.documentId } })
  }
}

describe('Fediverse federation (Phase 1: actor, keys, followers)', () => {
  let host: string
  let actorUrl: string
  let followersService: ReturnType<typeof followers>

  beforeAll(async () => {
    // Enable the fediverse plugin before Strapi boots (config/plugins.ts reads it).
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    await setupStrapi()

    host = serverHost()
    actorUrl = `http://${host}/fediverse/user/devbog`
    followersService = strapi.plugin('fediverse').service('followers')
  })

  afterAll(async () => {
    await cleanupStrapi()
  })

  afterEach(async () => {
    await clearFollowers()
  })

  it('derives the actor name and summary from the global settings single type', async () => {
    await writeGlobal({
      siteName: 'Test DevBog',
      siteDescription: 'A blog about testing federation.',
    })

    const res = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
    const body = (await res.json()) as ActorDocument

    expect(body.name).toBe('Test DevBog')
    expect(body.summary).toBe('A blog about testing federation.')
  })

  it('the actor document is the same before and after the reader moves', async () => {
    // The document the previous reader (`api::site-setting`) served for this profile, recorded
    // from it with the origin replaced by a placeholder and the keys left out (they are random).
    const recorded = readFileSync(
      join(__dirname, 'fixtures', 'fediverse-actor-before-site-read.json'),
      'utf8'
    )
    const icon = await createImage('avatar.png')
    const header = await createImage('header.png')
    await writeGlobal({
      siteName: 'Global name',
      siteDescription: 'Global bio.',
      favicon: icon.id,
    })
    await writeFediverseProfile({
      username: 'news_desk',
      displayName: 'The news desk',
      summary: 'What the component says.',
      header: header.id,
      discoverable: false,
      sourceUrl: 'https://code.example.test/component',
    })

    try {
      const res = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
      const body = (await res.json()) as Record<string, unknown>
      delete body.assertionMethod
      delete body.publicKey

      expect(JSON.parse(JSON.stringify(body).split(`http://${host}`).join('{{origin}}'))).toEqual(
        JSON.parse(recorded)
      )
    } finally {
      await writeFediverseProfile(null)
    }
  })

  it('never names the actor after the About page title', async () => {
    // No global or site settings, but an About page whose heading isn't a name.
    const documents = (uid: string) => ({
      findFirst: async () => (uid === 'api::about.about' ? { title: 'Acerca de este blog' } : null),
    })
    const profile = await strapi
      .plugin('fediverse')
      .service('actor-profile')
      .getActorProfile({ ...strapi, documents }, actorUrl)

    expect(profile.name).toBe('Micelio')
  })

  it('serves the avatar, header, frontend link and profile fields', async () => {
    const icon = await createImage('avatar.png')
    const header = await createImage('header.png')
    await writeGlobal({
      siteName: 'Test DevBog',
      siteDescription: 'A blog about testing federation.',
      favicon: icon.id,
    })
    await writeFediverseProfile({ header: header.id })

    const res = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
    const body = (await res.json()) as ActorDocument

    expect(body.icon.url).toBe(`http://${host}/uploads/avatar.png`)
    expect(body.image.url).toBe(`http://${host}/uploads/header.png`)
    expect(body.url).toBe('https://blog.example.test/')
    const fields = body.attachment.map((field) => [field.type, field.name, field.value])
    expect(fields).toEqual([
      [
        'PropertyValue',
        'Blog',
        '<a href="https://blog.example.test/" rel="me nofollow noopener" target="_blank">blog.example.test</a>',
      ],
      [
        'PropertyValue',
        'Código',
        '<a href="https://github.com/bogd3v/micelio-cms" rel="me nofollow noopener" target="_blank">github.com/bogd3v/micelio-cms</a>',
      ],
    ])
  })

  it('sends Update(Person) to followers when the global settings change', async () => {
    const remote = await createRemoteActor({ preferredUsername: 'profile-reader' })
    try {
      await followersService.recordFollower(strapi, {
        actorId: remote.actorUrl,
        inbox: remote.inboxUrl,
      })

      await writeGlobal({ siteName: 'Renamed DevBog', siteDescription: 'New bio.' })

      const update = await waitUntil(() =>
        remote.inboxDeliveries.find(
          (a) =>
            a.type === 'Update' &&
            a.object?.type === 'Person' &&
            a.object?.name === 'Renamed DevBog'
        )
      )
      expect(update.actor).toMatch(/\/fediverse\/user\/devbog$/)
      expect(update.object?.id).toBe(update.actor)
      expect(update.object?.summary).toBe('New bio.')
    } finally {
      await remote.close()
    }
  })

  it('builds actor URLs with the public scheme when behind a TLS-terminating proxy', async () => {
    const res = await fetch(actorUrl, {
      headers: { accept: ACTIVITY_JSON, 'x-forwarded-proto': 'https' },
    })
    const body = (await res.json()) as ActorDocument

    expect(body.id).toBe(`https://${host}/fediverse/user/devbog`)
    expect(body.inbox).toBe(`https://${host}/fediverse/user/devbog/inbox`)
  })

  it('opts the actor into Mastodon directory discovery', async () => {
    const res = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
    const body = (await res.json()) as ActorDocument

    expect(body.discoverable).toBe(true)
  })

  it('persists the actor key pair instead of regenerating it on every request', async () => {
    const keysService = strapi.plugin('fediverse').service('keys')
    const stored = await keysService.getStoredKeyPairEntries(strapi)
    expect(stored).not.toBeNull()

    const keyOf = (body: ActorDocument) =>
      body.assertionMethod?.[0]?.publicKeyMultibase ?? body.publicKey?.publicKeyPem

    const resA = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
    const resB = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
    const keyA = keyOf((await resA.json()) as ActorDocument)
    const keyB = keyOf((await resB.json()) as ActorDocument)

    expect(keyA).toBeTruthy()
    expect(keyA).toBe(keyB)
  })

  describe('followers service', () => {
    it('upserts profile fields on re-follow', async () => {
      const input = {
        actorId: 'https://example.social/users/alice',
        handle: '@alice@example.social',
        name: 'Alice',
      }
      const created = await followersService.recordFollower(strapi, input)
      expect(created.blocked).toBe(false)
      expect(created.name).toBe('Alice')

      const updated = await followersService.recordFollower(strapi, {
        ...input,
        name: 'Alice Updated',
      })
      expect(updated.documentId).toBe(created.documentId)
      expect(updated.name).toBe('Alice Updated')
    })

    it('ignores re-follows entirely once an admin has blocked the actor', async () => {
      const input = {
        actorId: 'https://example.social/users/blocked-alice',
        name: 'Blocked Alice',
      }
      const created = await followersService.recordFollower(strapi, input)
      await strapi.db.query('plugin::fediverse.follower').update({
        where: { documentId: created.documentId },
        data: { blocked: true },
      })

      const reFollowed = await followersService.recordFollower(strapi, {
        ...input,
        name: 'New Name',
      })

      expect(reFollowed.blocked).toBe(true)
      expect(reFollowed.name).toBe('Blocked Alice')
    })

    it('removeFollower keeps the row of a blocked actor, so it cannot lift its own block', async () => {
      const created = await followersService.recordFollower(strapi, {
        actorId: 'https://example.social/users/blocked-carol',
      })
      await strapi.db.query('plugin::fediverse.follower').update({
        where: { documentId: created.documentId },
        data: { blocked: true },
      })

      await expect(followersService.removeFollower(strapi, created.actorId)).resolves.toBe(false)

      const row = await strapi.db
        .query('plugin::fediverse.follower')
        .findOne({ where: { actorId: created.actorId } })
      expect(row?.blocked).toBe(true)

      const reFollowed = await followersService.recordFollower(strapi, {
        actorId: created.actorId,
      })
      expect(reFollowed.blocked).toBe(true)
    })

    describe('duplicate rows for one actor', () => {
      const followerQuery = () => strapi.db.query('plugin::fediverse.follower')
      const rowsOf = (actorId: string) =>
        followerQuery().findMany({ where: { actorId }, orderBy: { id: 'asc' } })
      // `unique: true` creates no database index, so concurrent Follows can leave two rows.
      const insertDuplicates = async (actorId: string, blockedFlags: boolean[]) => {
        for (const blocked of blockedFlags) {
          await followerQuery().create({
            data: { actorId, blocked, site: await defaultSiteRelation() },
          })
        }
      }

      it('settles concurrent Follows from one actor into a single row', async () => {
        const actorId = 'https://race.example/users/racer'

        await Promise.all(
          Array.from({ length: 5 }, () => followersService.recordFollower(strapi, { actorId }))
        )

        expect(await rowsOf(actorId)).toHaveLength(1)
      })

      it('treats an actor as blocked when any of its rows is blocked', async () => {
        const actorId = 'https://dup.example/users/dup-blocked'
        await insertDuplicates(actorId, [false, true])

        await expect(followersService.isActorBlocked(strapi, actorId)).resolves.toBe(true)
        expect((await followersService.listFollowers(strapi)).map((f) => f.actorId)).not.toContain(
          actorId
        )
        // The blocked actor's unblocked duplicate is not counted either.
        await expect(followersService.countFollowers(strapi)).resolves.toBe(0)
        await insertDuplicates('https://dup.example/users/dup-ok', [false])
        await expect(followersService.countFollowers(strapi)).resolves.toBe(1)
      })

      it('keeps every row of a blocked actor on Undo or Block', async () => {
        const actorId = 'https://dup.example/users/dup-undo'
        await insertDuplicates(actorId, [false, true])

        await expect(followersService.removeFollower(strapi, actorId)).resolves.toBe(false)

        expect(await rowsOf(actorId)).toHaveLength(2)
      })

      it('removes all rows of an actor that is not blocked', async () => {
        const actorId = 'https://dup.example/users/dup-plain'
        await insertDuplicates(actorId, [false, false])

        await expect(followersService.removeFollower(strapi, actorId)).resolves.toBe(true)

        expect(await rowsOf(actorId)).toHaveLength(0)
      })

      it('merges the duplicates on the next Follow and keeps the block', async () => {
        const actorId = 'https://dup.example/users/dup-merge'
        await insertDuplicates(actorId, [false, true])

        const record = await followersService.recordFollower(strapi, { actorId })

        expect(record.blocked).toBe(true)
        const rows = await rowsOf(actorId)
        expect(rows).toHaveLength(1)
        expect(rows[0].blocked).toBe(true)
      })
    })

    it('removeFollower deletes the row and reports whether one existed', async () => {
      const created = await followersService.recordFollower(strapi, {
        actorId: 'https://example.social/users/bob',
      })

      await expect(followersService.removeFollower(strapi, created.actorId)).resolves.toBe(true)
      await expect(followersService.removeFollower(strapi, created.actorId)).resolves.toBe(false)
    })

    it('listFollowers/countFollowers exclude blocked actors by default', async () => {
      await followersService.recordFollower(strapi, {
        actorId: 'https://example.social/users/carol',
      })
      const blocked = await followersService.recordFollower(strapi, {
        actorId: 'https://example.social/users/dave',
      })
      await strapi.db.query('plugin::fediverse.follower').update({
        where: { documentId: blocked.documentId },
        data: { blocked: true },
      })

      const list = await followersService.listFollowers(strapi)
      expect(list.map((f) => f.actorId)).toEqual(['https://example.social/users/carol'])
      await expect(followersService.countFollowers(strapi)).resolves.toBe(1)
    })
  })

  describe('followers dispatcher', () => {
    it('serves the public followers collection, counting only non-blocked followers', async () => {
      await followersService.recordFollower(strapi, {
        actorId: 'https://example.social/users/erin',
      })
      const blocked = await followersService.recordFollower(strapi, {
        actorId: 'https://example.social/users/frank',
      })
      await strapi.db.query('plugin::fediverse.follower').update({
        where: { documentId: blocked.documentId },
        data: { blocked: true },
      })

      const res = await fetch(`${actorUrl}/followers`, { headers: { accept: ACTIVITY_JSON } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { totalItems: number }

      expect(body.totalItems).toBe(1)
    })
  })

  describe('NodeInfo dispatcher', () => {
    it('reports honest software identity and usage stats', async () => {
      const res = await fetch(`http://${host}/nodeinfo/2.1`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        software: { name: string }
        protocols: string[]
        usage: { localPosts: number }
      }

      expect(body.software.name).toBe('micelio-cms')
      expect(body.protocols).toContain('activitypub')
      expect(typeof body.usage.localPosts).toBe('number')
    })
  })

  describe('signed inbox activities', () => {
    it('accepts a signed Follow: records the follower and sends back a signed Accept', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'signed-alice' })
      try {
        const res = await remote.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${remote.actorUrl}/follows/1`,
          type: 'Follow',
          actor: remote.actorUrl,
          object: actorUrl,
        })
        expect(res.ok).toBe(true)

        await waitUntil(() =>
          strapi.db
            .query('plugin::fediverse.follower')
            .findOne({ where: { actorId: remote.actorUrl } })
        )

        const accept = await waitUntil(() =>
          remote.inboxDeliveries.find((activity) => activity.type === 'Accept')
        )
        expect(accept.actor).toBe(actorUrl)
      } finally {
        await remote.close()
      }
    })

    it.each([
      ['javascript:alert(1)', null],
      ['data:image/png;base64,iVBORw0KGgo=', null],
      [`https://cdn.example.test/${'a'.repeat(300)}`, null],
      ['https://cdn.example.test/follower.png', 'https://cdn.example.test/follower.png'],
    ])('stores a follower avatar of %s as %s', async (rawIconUrl, expected) => {
      const remote = await createRemoteActor({ preferredUsername: 'avatar-follow', rawIconUrl })
      try {
        const res = await remote.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${remote.actorUrl}/follows/avatar`,
          type: 'Follow',
          actor: remote.actorUrl,
          object: actorUrl,
        })
        expect(res.ok).toBe(true)

        const row = await waitUntil(() =>
          strapi.db
            .query('plugin::fediverse.follower')
            .findOne({ where: { actorId: remote.actorUrl } })
        )
        expect(row.avatar ?? null).toBe(expected)
      } finally {
        await remote.close()
      }
    })

    it('sends no Accept to a blocked actor that follows', async () => {
      const blocked = await createRemoteActor({ preferredUsername: 'blocked-follow' })
      const sentinel = await createRemoteActor({ preferredUsername: 'sentinel-follow' })
      try {
        const row = await followersService.recordFollower(strapi, {
          actorId: blocked.actorUrl,
          inbox: blocked.inboxUrl,
        })
        await strapi.db.query('plugin::fediverse.follower').update({
          where: { documentId: row.documentId },
          data: { blocked: true },
        })

        const follow = (remote: typeof blocked) =>
          remote.postSignedActivity(`${actorUrl}/inbox`, {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id: `${remote.actorUrl}/follows/blocked`,
            type: 'Follow',
            actor: remote.actorUrl,
            object: actorUrl,
          })
        expect((await follow(blocked)).ok).toBe(true)
        expect((await follow(sentinel)).ok).toBe(true)

        // Inbox listeners run inline, before the POST returns (there is no queue): the
        // sentinel's Accept confirms the blocked actor's Follow has already been handled.
        await waitUntil(() =>
          sentinel.inboxDeliveries.find((activity) => activity.type === 'Accept')
        )
        expect(blocked.inboxDeliveries.find((activity) => activity.type === 'Accept')).toBe(
          undefined
        )
        const kept = await strapi.db
          .query('plugin::fediverse.follower')
          .findOne({ where: { actorId: blocked.actorUrl } })
        expect(kept?.blocked).toBe(true)
      } finally {
        await blocked.close()
        await sentinel.close()
      }
    })

    it('ignores a Follow addressed to a different actor', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'misaddressed' })
      try {
        const res = await remote.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${remote.actorUrl}/follows/1`,
          type: 'Follow',
          actor: remote.actorUrl,
          object: `http://${host}/fediverse/user/somebody-else`,
        })
        expect(res.ok).toBe(true)

        // Give the (synchronously-processed) listener a moment to run, then
        // confirm it did not record a follower for a Follow aimed elsewhere.
        await new Promise((resolve) => setTimeout(resolve, 200))
        const row = await strapi.db
          .query('plugin::fediverse.follower')
          .findOne({ where: { actorId: remote.actorUrl } })
        expect(row).toBeNull()
      } finally {
        await remote.close()
      }
    })

    it('removes the follower on Undo(Follow)', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'signed-bob' })
      try {
        await followersService.recordFollower(strapi, {
          actorId: remote.actorUrl,
          inbox: remote.inboxUrl,
        })

        const res = await remote.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${remote.actorUrl}/undo/1`,
          type: 'Undo',
          actor: remote.actorUrl,
          object: {
            id: `${remote.actorUrl}/follows/1`,
            type: 'Follow',
            actor: remote.actorUrl,
            object: actorUrl,
          },
        })
        expect(res.ok).toBe(true)

        await waitUntil(async () => {
          const row = await strapi.db
            .query('plugin::fediverse.follower')
            .findOne({ where: { actorId: remote.actorUrl } })
          return row == null
        })
      } finally {
        await remote.close()
      }
    })

    it('keeps a blocked actor blocked when it sends Undo(Follow) or Block', async () => {
      const blocked = await createRemoteActor({ preferredUsername: 'blocked-undo' })
      const sentinel = await createRemoteActor({ preferredUsername: 'sentinel-undo' })
      try {
        const row = await followersService.recordFollower(strapi, {
          actorId: blocked.actorUrl,
          inbox: blocked.inboxUrl,
        })
        await strapi.db.query('plugin::fediverse.follower').update({
          where: { documentId: row.documentId },
          data: { blocked: true },
        })
        await followersService.recordFollower(strapi, {
          actorId: sentinel.actorUrl,
          inbox: sentinel.inboxUrl,
        })

        const undo = (remote: typeof blocked) =>
          remote.postSignedActivity(`${actorUrl}/inbox`, {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id: `${remote.actorUrl}/undo/keep`,
            type: 'Undo',
            actor: remote.actorUrl,
            object: {
              id: `${remote.actorUrl}/follows/keep`,
              type: 'Follow',
              actor: remote.actorUrl,
              object: actorUrl,
            },
          })
        expect((await undo(blocked)).ok).toBe(true)
        const block = await blocked.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${blocked.actorUrl}/block/keep`,
          type: 'Block',
          actor: blocked.actorUrl,
          object: actorUrl,
        })
        expect(block.ok).toBe(true)

        // Inbox listeners run inline, before the POST returns (there is no queue): the
        // sentinel's removal confirms the listeners above have already run.
        expect((await undo(sentinel)).ok).toBe(true)
        await waitUntil(async () => {
          const gone = await strapi.db
            .query('plugin::fediverse.follower')
            .findOne({ where: { actorId: sentinel.actorUrl } })
          return gone == null
        })

        const kept = await strapi.db
          .query('plugin::fediverse.follower')
          .findOne({ where: { actorId: blocked.actorUrl } })
        expect(kept?.blocked).toBe(true)
      } finally {
        await blocked.close()
        await sentinel.close()
      }
    })

    it("does not let one account undo another account's follow on the same server", async () => {
      const attacker = await createRemoteActor({ preferredUsername: 'attacker' })
      try {
        // Same origin as the attacker: Fedify trusts objects embedded from the
        // sender's own origin, so only our actor check stands in the way.
        const victimId = `${new URL(attacker.actorUrl).origin}/users/victim`
        await followersService.recordFollower(strapi, { actorId: victimId })

        // Signed by the attacker, but embedding a Follow that claims to be the victim's.
        const res = await attacker.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${attacker.actorUrl}/undo/forged`,
          type: 'Undo',
          actor: attacker.actorUrl,
          object: {
            id: `${victimId}/follows/1`,
            type: 'Follow',
            actor: victimId,
            object: actorUrl,
          },
        })
        expect(res.ok).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 500))

        const row = await strapi.db
          .query('plugin::fediverse.follower')
          .findOne({ where: { actorId: victimId } })
        expect(row).not.toBeNull()
      } finally {
        await attacker.close()
      }
    })

    it('removes the follower on Block', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'signed-carol' })
      try {
        await followersService.recordFollower(strapi, {
          actorId: remote.actorUrl,
          inbox: remote.inboxUrl,
        })

        const res = await remote.postSignedActivity(`${actorUrl}/inbox`, {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${remote.actorUrl}/block/1`,
          type: 'Block',
          actor: remote.actorUrl,
          object: actorUrl,
        })
        expect(res.ok).toBe(true)

        await waitUntil(async () => {
          const row = await strapi.db
            .query('plugin::fediverse.follower')
            .findOne({ where: { actorId: remote.actorUrl } })
          return row == null
        })
      } finally {
        await remote.close()
      }
    })
  })

  describe('profile in the site settings (#303)', () => {
    const VARIABLES = [
      'FEDIVERSE_ACTOR_NAME',
      'FEDIVERSE_ACTOR_SUMMARY',
      'FEDIVERSE_ACTOR_SOURCE_URL',
    ] as const

    async function readActor(): Promise<ActorDocument> {
      const res = await fetch(actorUrl, { headers: { accept: ACTIVITY_JSON } })
      return (await res.json()) as ActorDocument
    }

    async function clearProfileSources() {
      const existing = await strapi.documents('api::global.global').findFirst()
      if (existing) {
        await strapi.documents('api::global.global').delete({ documentId: existing.documentId })
      }
      await updateDefaultSite({ name: 'Site Name', description: null })
      await writeFediverseProfile(null)
      for (const name of VARIABLES) delete process.env[name]
    }

    beforeEach(clearProfileSources)
    afterAll(clearProfileSources)

    it('shows the component values, ahead of the variables and the global settings', async () => {
      process.env.FEDIVERSE_ACTOR_NAME = 'Variable name'
      process.env.FEDIVERSE_ACTOR_SUMMARY = 'Variable bio.'
      process.env.FEDIVERSE_ACTOR_SOURCE_URL = 'https://code.example.test/variable'
      await writeGlobal({ siteName: 'Global name', siteDescription: 'Global bio.' })
      const header = await createImage('profile-header.png')
      await writeFediverseProfile({
        username: 'news_desk',
        displayName: 'The news desk',
        summary: 'What the component says.',
        header: header.id,
        discoverable: false,
        sourceUrl: 'https://code.example.test/component',
      })

      const body = await readActor()

      expect(body).toMatchObject({
        preferredUsername: 'news_desk',
        name: 'The news desk',
        summary: 'What the component says.',
        discoverable: false,
        image: { url: `http://${host}/uploads/profile-header.png` },
      })
      expect(body.attachment[1].value).toContain('https://code.example.test/component')
    })

    it('no longer reads the removed variables when the component is empty (#307)', async () => {
      process.env.FEDIVERSE_ACTOR_NAME = 'Variable name'
      process.env.FEDIVERSE_ACTOR_SUMMARY = 'Variable bio.'
      process.env.FEDIVERSE_ACTOR_SOURCE_URL = 'https://code.example.test/variable'
      // The default site's own name would come first, so "Micelio" shows only without it.
      await updateDefaultSite({ name: ' ' })

      const body = await readActor()

      expect(body.name).toBe('Micelio')
      expect(body.summary).toBeUndefined()
      expect(body.preferredUsername).toBe('devbog')
      expect(body.attachment[1].value).toContain('github.com/bogd3v/micelio-cms')
      expect(body.attachment[1].value).not.toContain('code.example.test')
    })

    it('falls back to the site name, with no summary and no header, when everything is empty', async () => {
      const body = await readActor()

      expect(body.name).toBe('Site Name')
      expect(body.summary).toBeUndefined()
      expect(body.image).toBeUndefined()
      expect(body.attachment[1].value).toContain('github.com/bogd3v/micelio-cms')
    })

    it('rejects a username with an invalid character', async () => {
      for (const username of ['News Desk', 'news.desk', 'News', 'news@desk']) {
        await expect(writeFediverseProfile({ username })).rejects.toThrow()
      }
      await expect(writeFediverseProfile({ username: 'news_desk_2' })).resolves.toBeDefined()
    })

    it('rejects a summary over 500 characters', async () => {
      await expect(writeFediverseProfile({ summary: 'x'.repeat(501) })).rejects.toThrow()
    })

    it('resolves the new handle through WebFinger, and the identifier as the former one', async () => {
      await writeFediverseProfile({ username: 'news_desk' })
      const resolve = async (username: string) =>
        fetch(`http://${host}/.well-known/webfinger?resource=acct:${username}@${host}`, {
          headers: { accept: 'application/jrd+json' },
        })

      // The identifier keeps resolving as the former handle.
      for (const username of ['news_desk', 'devbog']) {
        const res = await resolve(username)
        expect(res.status).toBe(200)
        const jrd = (await res.json()) as { links: { rel: string; href: string }[] }
        expect(jrd.links.find((link) => link.rel === 'self')?.href).toBe(actorUrl)
      }
      expect((await resolve('nobody')).status).toBe(404)
    })

    it('sends Update(Person) when the component is saved in another locale', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'es-reader' })
      try {
        await followersService.recordFollower(strapi, {
          actorId: remote.actorUrl,
          inbox: remote.inboxUrl,
        })
        // The Spanish version first, so the save below is an edit of an existing locale.
        await updateDefaultSite({ name: 'Sitio' }, 'es')
        await updateDefaultSite({ fediverse: { displayName: 'La mesa de noticias' } }, 'es')

        await waitUntil(() =>
          remote.inboxDeliveries.find(
            (a) => a.type === 'Update' && a.object?.name === 'La mesa de noticias'
          )
        )
      } finally {
        await remote.close()
      }
    })

    it('sends no Update(Person) when the saved settings leave the actor as it was', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'quiet-reader' })
      try {
        await followersService.recordFollower(strapi, {
          actorId: remote.actorUrl,
          inbox: remote.inboxUrl,
        })
        await writeFediverseProfile({ displayName: 'Steady name' })
        await waitUntil(() => remote.inboxDeliveries.find((a) => a.object?.name === 'Steady name'))
        const sent = remote.inboxDeliveries.length

        // Same profile again, and a setting the actor does not show.
        await writeFediverseProfile({ displayName: 'Steady name' })
        await updateDefaultSite({ tagline: 'Not on the actor' })
        await new Promise((resolve) => setTimeout(resolve, 1500))

        expect(remote.inboxDeliveries).toHaveLength(sent)
      } finally {
        await remote.close()
      }
    })

    it('sends Update(Person) to followers when the component is saved', async () => {
      const remote = await createRemoteActor({ preferredUsername: 'settings-reader' })
      try {
        await followersService.recordFollower(strapi, {
          actorId: remote.actorUrl,
          inbox: remote.inboxUrl,
        })

        await writeFediverseProfile({ username: 'news_desk', displayName: 'The news desk' })

        const update = await waitUntil(() =>
          remote.inboxDeliveries.find(
            (a) =>
              a.type === 'Update' &&
              a.object?.type === 'Person' &&
              a.object?.name === 'The news desk'
          )
        )
        expect(update.object?.preferredUsername).toBe('news_desk')
        expect(update.object?.id).toBe(update.actor)
      } finally {
        await remote.close()
      }
    })
  })
})
