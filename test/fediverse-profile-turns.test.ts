import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupStrapi, cleanupStrapi } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { writeFediverseProfile } from './helpers/fediverse-profile'
import { waitUntil } from './helpers/wait-until'

// The core is loaded as CommonJS, as Strapi loads it (see `helpers/fediverse-profile.ts`).
const { SITE_UID } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

describe('Update(Person) of a site, one turn at a time', () => {
  let remote: RemoteActor

  /** The `Update(Person)` deliveries the remote follower has received. */
  function profileUpdates(): unknown[] {
    return remote.inboxDeliveries.filter((a) => a.type === 'Update' && a.object?.type === 'Person')
  }

  function named(name: string): unknown {
    return profileUpdates().find((a) => (a as { object?: { name?: string } }).object?.name === name)
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    remote = await createRemoteActor({ preferredUsername: 'turns-reader' })
    await setupStrapi()
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: remote.actorUrl, inbox: remote.inboxUrl })
  })

  afterAll(async () => {
    await cleanupStrapi()
    await remote.close()
  })

  it('sends the actor once when several changes of it are handled at the same time', async () => {
    const site = (await strapi.db.query(SITE_UID).findOne({
      where: { isDefault: true },
      select: ['documentId'],
    })) as { documentId: string }
    const store = strapi.store({ type: 'plugin', name: 'fediverse' })
    const key = `profileFingerprint:${site.documentId}`

    // The handler stores the fingerprint after it has sent: wait until it differs from the one
    // there was (the boot may have stored one), so replacing it cannot race with that store.
    const stored = await store.get({ key })
    await writeFediverseProfile({ displayName: 'Only name' })
    await waitUntil(() => named('Only name'))
    await waitUntil(async () => {
      const now = await store.get({ key })
      return now != null && now !== stored
    })
    const before = profileUpdates().length

    // The last actor sent is not the one served: three handlers that start together would each
    // find that out and each send, unless they take turns.
    await store.set({ key, value: 'stale' })
    // The `global` single type gives every actor its fallbacks: saving it emits one event per save.
    for (let save = 0; save < 3; save += 1) {
      strapi.eventHub.emit('entry.update', { uid: 'api::global.global', entry: {} })
    }
    // A save after them waits behind them in the turn, so its `Update(Person)` arrives after the
    // three handlers have finished: what was delivered before it is what they sent.
    await writeFediverseProfile({ displayName: 'Next name' })
    await waitUntil(() => named('Next name'))

    const sent = profileUpdates()
    const between = sent.slice(before, sent.indexOf(named('Next name')))
    expect(between).toHaveLength(1)
  })
})
