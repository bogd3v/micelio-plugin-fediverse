import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'

const ACTIVITY_JSON = 'application/activity+json'
const CMS_ORIGIN = 'https://cms.example.test'
const HANDLE_HOST = 'example.test'

describe('Fediverse handle host', () => {
  const saved = { ...process.env }
  const get = (path: string) =>
    fetch(`http://${serverHost()}${path}`, { headers: { accept: ACTIVITY_JSON } })
  const webfinger = (acct: string) =>
    get(`/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`)

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.URL = CMS_ORIGIN
    process.env.FEDIVERSE_HANDLE_HOST = HANDLE_HOST
    await setupStrapi()
    await setFediverseUsername('bogdev')
    // The first boot created the default site after the package's bootstrap; the next one is the
    // upgrade that pins the handle host as the first of the site's hosts.
    await cleanupStrapi({ keepDatabase: true })
    await setupStrapi({ keepDatabase: true })
  })

  afterAll(async () => {
    await cleanupStrapi()
    process.env = saved
  })

  it('answers WebFinger for the handle host with the actor id on the CMS origin', async () => {
    const res = await webfinger(`bogdev@${HANDLE_HOST}`)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      subject: string
      links: Array<{ rel: string; href: string }>
    }
    expect(body.subject).toBe(`acct:bogdev@${HANDLE_HOST}`)
    expect(body.links.find((link) => link.rel === 'self')?.href).toBe(
      `${CMS_ORIGIN}/fediverse/user/devbog`
    )
  })

  it('answers for the identifier on the handle host too', async () => {
    const res = await webfinger(`devbog@${HANDLE_HOST}`)

    expect(res.status).toBe(200)
    expect(((await res.json()) as { subject: string }).subject).toBe(`acct:devbog@${HANDLE_HOST}`)
  })

  // Fedify resolves only `handleHost` once it is split from the web origin: the former handle
  // `@bogdev@cms.example.test` stops resolving, which docs/architecture/federation.md says.
  it('stops answering for the CMS host and for any other host', async () => {
    expect((await webfinger('bogdev@cms.example.test')).status).toBe(404)
    expect((await webfinger('bogdev@elsewhere.example')).status).toBe(404)
  })

  it('keeps the actor id, inbox, outbox, key id, username and url as without the variable', async () => {
    const body = (await (await get('/fediverse/user/devbog')).json()) as {
      id: string
      inbox: string
      outbox: string
      preferredUsername: string
      url: string
      publicKey: { id: string }
    }

    expect(body.id).toBe(`${CMS_ORIGIN}/fediverse/user/devbog`)
    expect(body.inbox).toBe(`${CMS_ORIGIN}/fediverse/user/devbog/inbox`)
    expect(body.outbox).toBe(`${CMS_ORIGIN}/fediverse/user/devbog/outbox`)
    expect(body.publicKey.id).toBe(`${CMS_ORIGIN}/fediverse/user/devbog#main-key`)
    expect(body.preferredUsername).toBe('bogdev')
    expect(body.url).toBe('https://blog.example.test/')
  })
})
