import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { verifyJsonLd } from '@fedify/fedify'
import { PUBLIC_COLLECTION } from '@fedify/fedify/vocab'
import { writeFediverseProfile } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { ActorUpdate, AttributedPerson } from '../server/src/attributed-actor'
import { attributionDomains } from '../server/src/utils/attribution-domains'

const ACTIVITY_JSON = 'application/activity+json'
const IRI = 'http://joinmastodon.org/ns#attributionDomains'
const AS_OBJECT = 'https://www.w3.org/ns/activitystreams#object'
/** Mastodon's own definition of the term (`app/helpers/context_helper.rb`). */
const TERM = { '@id': 'toot:attributionDomains', '@container': '@set' }
/** The origin Fedify builds ids from outside a request in tests (`URL` unset: Strapi's default). */
const CONTEXT_ORIGIN = 'http://localhost:1337'

type Json = Record<string, unknown>

/** Whether one of the `@context` entries defines `attributionDomains` as Mastodon does. */
function definesTerm(context: unknown): boolean {
  const entries = Array.isArray(context) ? context : [context]
  return entries.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      JSON.stringify((entry as Json).attributionDomains) === JSON.stringify(TERM)
  )
}

function person(domains?: string[]): AttributedPerson {
  return new AttributedPerson({
    id: new URL('https://cms.example.test/fediverse/user/devbog'),
    preferredUsername: 'blog',
    inbox: new URL('https://cms.example.test/fediverse/user/devbog/inbox'),
    attributionDomains: domains,
  })
}

describe('attributionDomains', () => {
  const savedUrl = process.env.URL
  afterAll(() => {
    if (savedUrl === undefined) delete process.env.URL
    else process.env.URL = savedUrl
  })

  it('is the host of FRONTEND_URL, lowercase, without port or path', () => {
    expect(attributionDomains({ FRONTEND_URL: 'https://Blog.Example.test:8443/es/' })).toEqual([
      'blog.example.test',
    ])
  })

  it('adds the handle host when it differs, once', () => {
    process.env.URL = 'https://cms.example.test'
    const env = { FRONTEND_URL: 'https://www.example.test', FEDIVERSE_HANDLE_HOST: 'example.test' }
    expect(attributionDomains(env)).toEqual(['www.example.test', 'example.test'])
    expect(
      attributionDomains({
        FRONTEND_URL: 'https://example.test',
        FEDIVERSE_HANDLE_HOST: 'example.test',
      })
    ).toEqual(['example.test'])
  })

  it('is empty when neither variable names a domain', () => {
    expect(attributionDomains({})).toEqual([])
    expect(attributionDomains({ FRONTEND_URL: '  ' })).toEqual([])
    expect(attributionDomains({ FRONTEND_URL: 'not a url' })).toEqual([])
  })
})

describe('AttributedPerson and ActorUpdate', () => {
  it('serialize the bare key, plain strings and the term Mastodon defines', async () => {
    const json = (await person(['blog.example.test']).toJsonLd({ format: 'compact' })) as Json
    expect(json.attributionDomains).toEqual(['blog.example.test'])
    expect(definesTerm(json['@context'])).toBe(true)
  })

  it('expand to string literals, not IRIs', async () => {
    const [node] = (await person(['blog.example.test']).toJsonLd({ format: 'expand' })) as Json[]
    expect(node[IRI]).toEqual([{ '@value': 'blog.example.test' }])
  })

  it('keep the domains on a clone', async () => {
    const copy = person(['blog.example.test']).clone({ name: 'Renamed' })
    expect(((await copy.toJsonLd()) as Json).attributionDomains).toEqual(['blog.example.test'])
  })

  it('leave the document as Fedify builds it when there are no domains', async () => {
    const json = (await person().toJsonLd()) as Json
    expect(json).not.toHaveProperty('attributionDomains')
    expect(definesTerm(json['@context'])).toBe(false)
  })

  it('embed the actor in an Update with the bare key, in every format', async () => {
    const actor = person(['blog.example.test'])
    const update = new ActorUpdate({
      id: new URL('#profile-update/1', actor.id!),
      actor: actor.id,
      object: actor,
      to: PUBLIC_COLLECTION,
    })
    for (const format of [undefined, 'compact'] as const) {
      const json = (await update.toJsonLd({ format })) as Json
      const object = json.object as Json
      expect(object.attributionDomains).toEqual(['blog.example.test'])
      expect(object).not.toHaveProperty(['toot:attributionDomains'])
      expect(definesTerm(json['@context'])).toBe(true)
    }
    const [node] = (await update.toJsonLd({ format: 'expand' })) as Json[]
    expect((node[AS_OBJECT] as Json[])[0][IRI]).toEqual([{ '@value': 'blog.example.test' }])
  })
})

describe('Fediverse author attribution (actor and Update(Person))', () => {
  let remote: RemoteActor

  /** The served actor document, read the way a remote server reads it. */
  async function readActor(): Promise<Json> {
    const res = await fetch(`http://${serverHost()}/fediverse/user/devbog`, {
      headers: { accept: ACTIVITY_JSON },
    })
    return (await res.json()) as Json
  }

  /** The `Update(Person)` deliveries the remote follower has received. */
  function profileUpdates(): Json[] {
    return remote.inboxDeliveries.filter(
      (a) => a.type === 'Update' && a.object?.type === 'Person'
    ) as unknown as Json[]
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    remote = await createRemoteActor({ preferredUsername: 'attribution-reader' })
    await setupStrapi()
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterEach(() => {
    process.env.FRONTEND_URL = 'https://blog.example.test'
  })

  afterAll(async () => {
    await cleanupStrapi()
    await remote.close()
  })

  it('lists the frontend host in the actor document, as Mastodon reads it', async () => {
    const actor = await readActor()
    expect(actor.attributionDomains).toEqual(['blog.example.test'])
    expect(definesTerm(actor['@context'])).toBe(true)
  })

  it('serves no attributionDomains when no variable names a domain', async () => {
    delete process.env.FRONTEND_URL
    const actor = await readActor()
    expect(actor).not.toHaveProperty('attributionDomains')
  })

  it('carries the domains in the Update(Person) sent to followers, under a valid signature', async () => {
    await writeFediverseProfile({ displayName: 'Attributed blog' })

    const update = await waitUntil(() =>
      profileUpdates().find((a) => (a.object as Json).name === 'Attributed blog')
    )
    const object = update.object as Json
    expect(object.attributionDomains).toEqual(['blog.example.test'])
    expect(definesTerm(update['@context'])).toBe(true)

    // The Linked Data signature Mastodon checks covers the body as sent, the domains included.
    // Outside a request the ids are built on `CONTEXT_ORIGIN`, over HTTP on the test server's.
    const served = `http://${serverHost()}`
    const documentLoader = async (url: string) => {
      const res = await fetch(url.replace(CONTEXT_ORIGIN, served), {
        headers: { accept: ACTIVITY_JSON },
      })
      const text = (await res.text()).split(served).join(CONTEXT_ORIGIN)
      return { document: JSON.parse(text) as unknown, documentUrl: url, contextUrl: null }
    }
    expect(update).toHaveProperty('signature')
    expect(await verifyJsonLd(update, { documentLoader })).toBe(true)
    const tampered = structuredClone(update)
    ;(tampered.object as Json).attributionDomains = ['attacker.example.test']
    expect(await verifyJsonLd(tampered, { documentLoader })).toBe(false)
  })

  it('sends Update(Person) on a restart that changes the domain, and nothing on one that does not', async () => {
    await cleanupStrapi({ keepDatabase: true })
    process.env.FRONTEND_URL = 'https://news.example.test'
    await setupStrapi({ keepDatabase: true })

    const update = await waitUntil(() =>
      profileUpdates().find((a) =>
        JSON.stringify((a.object as Json).attributionDomains).includes('news.example.test')
      )
    )
    expect((update.object as Json).attributionDomains).toEqual(['news.example.test'])
    const sent = remote.inboxDeliveries.length

    await cleanupStrapi({ keepDatabase: true })
    await setupStrapi({ keepDatabase: true })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(remote.inboxDeliveries).toHaveLength(sent)
  })
})
