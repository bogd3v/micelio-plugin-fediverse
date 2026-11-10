import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { updateDefaultSite, writeFediverseProfile } from './helpers/fediverse-profile'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import {
  createSite,
  readSite,
  setHosts,
  SECTION,
  siteIdOf,
  jsonOf,
  type JsonBody,
} from './helpers/sites'
import { waitUntil } from './helpers/wait-until'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'

const { missingLocales } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

const ACTIVITY_JSON = 'application/activity+json'
const ARTICLE_UID = 'api::article.article'

type Json = JsonBody

describe('One actor per site, from the fediverse profile of the site', () => {
  let remote: RemoteActor
  const saved = { ...process.env }
  const get = async (path: string): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`http://${serverHost()}${path}`, {
      headers: { accept: ACTIVITY_JSON },
    })
    return { status: res.status, body: await jsonOf(res) }
  }
  const profileUpdates = (): Json[] =>
    remote.inboxDeliveries.filter(
      (a) => a.type === 'Update' && a.object?.type === 'Person'
    ) as unknown as Json[]

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    remote = await createRemoteActor({ preferredUsername: 'site-actor-reader' })
    await setupStrapi()
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterAll(async () => {
    await cleanupStrapi()
    await remote.close()
    process.env = saved
  })

  it("serves the display name, summary and object type of the site's fediverse profile, and federates a published article as Article", async () => {
    await writeFediverseProfile({
      displayName: 'The profile name',
      summary: 'What the profile says.',
      objectType: 'article',
    })

    const actor = await get('/fediverse/user/devbog')
    expect(actor.status).toBe(200)
    expect(actor.body.name).toBe('The profile name')
    expect(actor.body.summary).toBe('What the profile says.')

    const draft = await strapi.documents(ARTICLE_UID).create({
      data: { title: 'As an article', slug: 'as-an-article', description: 'x' },
    })
    await strapi.documents(ARTICLE_UID).publish({ documentId: draft.documentId })

    const served = await get(`/fediverse/articles/${draft.documentId}`)
    expect(served.body.type).toBe('Article')
    const create = await waitUntil(() =>
      remote.inboxDeliveries.find((a) => a.type === 'Create' && a.object?.type === 'Article')
    )
    expect(create.object?.name).toBe('As an article')
  })

  it('serves a second actor with its own name and identifier for a second site', async () => {
    const second = await createSite('site-b', {
      hosts: ['b.example.test'],
      fediverse: { displayName: 'The second name', username: 'second' },
    })

    // A new site's identifier is its slug (written by the `siteCreated` hook).
    expect((await readSite(second)).identifier).toBe('site-b')
    expect((await readSite()).identifier).toBeNull()

    const actor = await get('/fediverse/user/site-b')
    expect(actor.status).toBe(200)
    expect(actor.body.name).toBe('The second name')
    expect(actor.body.preferredUsername).toBe('second')
    expect(actor.body.id).toMatch(/\/fediverse\/user\/site-b$/)
    expect(actor.body.attributionDomains).toEqual(['b.example.test'])
    expect((await get('/fediverse/user/devbog')).body.name).not.toBe('The second name')

    // It has no followers of the first site's, and no articles of its own.
    expect((await get('/fediverse/user/site-b/followers')).body.totalItems).toBe(0)
    expect((await get('/fediverse/user/site-b/outbox')).body.totalItems).toBe(0)
    const page = (await get('/fediverse/user/site-b/outbox?cursor=0')).body
    expect(page.orderedItems ?? []).toEqual([])
    expect((await get('/fediverse/user/nobody')).status).toBe(404)
  })

  it("records a follow of a second site's actor on that site, and answers it with its own Accept", async () => {
    const follower = await createRemoteActor({ preferredUsername: 'site-b-reader' })
    try {
      const actor = `http://${serverHost()}/fediverse/user/site-b`
      const res = await follower.postSignedActivity(`${actor}/inbox`, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${follower.actorUrl}/follows/site-b`,
        type: 'Follow',
        actor: follower.actorUrl,
        object: actor,
      })
      expect(res.ok).toBe(true)

      const accept = await waitUntil(() =>
        follower.inboxDeliveries.find((delivery) => delivery.type === 'Accept')
      )
      expect(accept.actor).toBe(actor)
      const { documentId } = await readSite(await siteIdOf('site-b'))
      const service = strapi.plugin('fediverse').service('followers')
      expect(
        (await service.listFollowers(strapi, { site: documentId })).map((row: Json) => row.actorId)
      ).toEqual([follower.actorUrl])
      expect((await service.listFollowers(strapi)).map((row: Json) => row.actorId)).not.toContain(
        follower.actorUrl
      )
      expect((await get('/fediverse/user/site-b/followers')).body.totalItems).toBe(1)
    } finally {
      await follower.close()
    }
  })

  it('registers the fediverse-actor section with its label in both locales', () => {
    const extensions = strapi.plugin('micelio').service('extensions')
    const section = extensions
      .siteSections()
      .find((candidate: { id: string }) => candidate.id === 'fediverse-actor')
    expect(section).toMatchObject({
      component: 'fediverse.actor',
      panel: 'fediverse.actor',
      permission: 'plugin::fediverse.read',
    })
    expect(missingLocales(section.label)).toEqual([])
    expect(extensions.siteSectionAttribute('fediverse-actor')).toBe(SECTION)
    expect(
      (strapi.components as unknown as Record<string, { attributes: unknown }>)['fediverse.actor']
        .attributes
    ).toEqual({
      identifier: { type: 'string', maxLength: 64 },
    })
  })

  it('sends one Update(Person) after the profile or the hosts of the site change', async () => {
    const moved = (a: Json) =>
      JSON.stringify((a.object as Json).attributionDomains ?? []).includes('moved.example.test')
    const named = (name: string) =>
      profileUpdates().filter((a) => (a.object as Json).name === name && !moved(a))

    await writeFediverseProfile({ displayName: 'Renamed once' })
    await waitUntil(() => named('Renamed once')[0])
    await setHosts(['blog.example.test', 'moved.example.test'])
    const hostsUpdate = await waitUntil(() => profileUpdates().find(moved))
    expect((hostsUpdate.object as Json).attributionDomains).toEqual([
      'blog.example.test',
      'moved.example.test',
    ])

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(named('Renamed once')).toHaveLength(1)
    expect(profileUpdates().filter(moved)).toHaveLength(1)
    // An unrelated change of the site sends nothing more.
    const sent = remote.inboxDeliveries.length
    await updateDefaultSite({ tagline: 'Not on the actor' })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(remote.inboxDeliveries).toHaveLength(sent)
  })
})
