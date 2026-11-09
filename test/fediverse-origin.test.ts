import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { publicOrigin } from '../server/src/utils/public-origin'

const ACTIVITY_JSON = 'application/activity+json'
const PUBLIC_ORIGIN = 'https://cms.example.test'

describe('publicOrigin', () => {
  const saved = process.env.URL
  afterAll(() => {
    if (saved === undefined) delete process.env.URL
    else process.env.URL = saved
  })

  it.each([
    ['https://cms.example.test', 'https://cms.example.test'],
    [' https://cms.example.test/ ', 'https://cms.example.test'],
    ['https://cms.example.test/cms', 'https://cms.example.test'],
    ['', undefined],
    ['not a url', undefined],
  ])('reads %j as %j', (value, expected) => {
    process.env.URL = value
    expect(publicOrigin()).toBe(expected)
  })

  it('is undefined when URL is unset', () => {
    delete process.env.URL
    expect(publicOrigin()).toBeUndefined()
  })
})

describe('Fediverse ids with a configured public URL', () => {
  const saved = { ...process.env }
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://${serverHost()}${path}`, {
      headers: { accept: ACTIVITY_JSON, ...headers },
    })
  const forged = { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    process.env.URL = PUBLIC_ORIGIN
    await setupStrapi()
    await setFediverseUsername('bogdev')
  })

  afterAll(async () => {
    await cleanupStrapi()
    process.env = saved
  })

  it('builds the actor document from the public URL, whatever the forwarded headers say', async () => {
    for (const headers of [{}, forged]) {
      const body = (await (await get('/fediverse/user/devbog', headers)).json()) as {
        id: string
        inbox: string
        outbox: string
        publicKey: { id: string }
      }
      expect(body.id).toBe(`${PUBLIC_ORIGIN}/fediverse/user/devbog`)
      expect(body.inbox).toBe(`${PUBLIC_ORIGIN}/fediverse/user/devbog/inbox`)
      expect(body.outbox).toBe(`${PUBLIC_ORIGIN}/fediverse/user/devbog/outbox`)
      expect(body.publicKey.id).toBe(`${PUBLIC_ORIGIN}/fediverse/user/devbog#main-key`)
    }
  })

  it('builds the WebFinger links from the public URL too', async () => {
    const res = await get(
      `/.well-known/webfinger?resource=${encodeURIComponent('acct:bogdev@cms.example.test')}`,
      forged
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(`${PUBLIC_ORIGIN}/fediverse/user/devbog`)
    expect(text).not.toContain('evil.example')
  })
})
