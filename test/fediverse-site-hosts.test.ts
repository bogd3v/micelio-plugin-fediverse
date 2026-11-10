import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { setHosts, jsonOf } from './helpers/sites'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'

const CMS_ORIGIN = 'https://cms.example.test'

describe('The handle host and the attribution list come from the hosts of the site', () => {
  const saved = { ...process.env }
  const get = async (path: string) => {
    const res = await fetch(`http://${serverHost()}${path}`, {
      headers: { accept: 'application/activity+json' },
    })
    return { status: res.status, body: await jsonOf(res) }
  }
  const webfinger = (acct: string) =>
    get(`/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`)

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.URL = CMS_ORIGIN
    delete process.env.FEDIVERSE_HANDLE_HOST
    await setupStrapi()
    await setFediverseUsername('bogdev')
  })

  afterAll(async () => {
    await cleanupStrapi()
    process.env = saved
  })

  it('takes the handle host from hosts[0] and lists every host in attributionDomains', async () => {
    await setHosts(['example.com', 'www.example.com'])

    const found = await webfinger('bogdev@example.com')
    expect(found.status).toBe(200)
    expect(found.body.subject).toBe('acct:bogdev@example.com')
    // The ids stay on the CMS origin.
    expect(found.body.links?.find((link) => link.rel === 'self')?.href).toBe(
      `${CMS_ORIGIN}/fediverse/user/devbog`
    )
    // The second host is not the handle host, and neither is the CMS host once hosts is filled.
    expect((await webfinger('bogdev@cms.example.test')).status).toBe(404)

    const actor = await get('/fediverse/user/devbog')
    expect(actor.body.attributionDomains).toEqual(['example.com', 'www.example.com'])
  })

  it('keeps the host of URL as the handle host and serves no attributionDomains when the site has no hosts', async () => {
    await setHosts([])

    const found = await webfinger('bogdev@cms.example.test')
    expect(found.status).toBe(200)
    expect(found.body.subject).toBe('acct:bogdev@cms.example.test')
    expect((await webfinger('bogdev@example.com')).status).toBe(404)

    const actor = await get('/fediverse/user/devbog')
    expect(actor.body).not.toHaveProperty('attributionDomains')
  })
})
