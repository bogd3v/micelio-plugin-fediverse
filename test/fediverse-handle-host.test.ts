import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { federationOrigin, handleHost, webFingerSubject } from '../server/src/utils/handle-host'

const ACTIVITY_JSON = 'application/activity+json'
const CMS_ORIGIN = 'https://cms.example.test'
const HANDLE_HOST = 'example.test'

describe('handleHost and federationOrigin', () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ ...vars })
  const saved = process.env.URL
  afterAll(() => {
    if (saved === undefined) delete process.env.URL
    else process.env.URL = saved
  })

  it('is unset by default, which keeps the handle on the CMS host', () => {
    process.env.URL = CMS_ORIGIN
    expect(handleHost(env({}))).toBeUndefined()
    expect(federationOrigin(env({}))).toBe(CMS_ORIGIN)
  })

  it('splits the handle host from the web origin when it names another host', () => {
    process.env.URL = CMS_ORIGIN
    const vars = env({ FEDIVERSE_HANDLE_HOST: ' Example.Test ' })
    expect(handleHost(vars)).toBe(HANDLE_HOST)
    expect(federationOrigin(vars)).toEqual({ handleHost: HANDLE_HOST, webOrigin: CMS_ORIGIN })
  })

  it('keeps the plain origin when it names the CMS host itself', () => {
    process.env.URL = CMS_ORIGIN
    expect(federationOrigin(env({ FEDIVERSE_HANDLE_HOST: 'cms.example.test' }))).toBe(CMS_ORIGIN)
  })

  it.each(['https://example.test', 'example.test/path', 'exa mple.test', 'example.test?x=1'])(
    'refuses %j and names the variable',
    (value) => {
      process.env.URL = CMS_ORIGIN
      expect(() => handleHost(env({ FEDIVERSE_HANDLE_HOST: value }))).toThrow(
        /FEDIVERSE_HANDLE_HOST must be a host/
      )
    }
  )

  it('refuses a handle host while URL is unset, because the ids need the CMS origin', () => {
    delete process.env.URL
    expect(() => handleHost(env({ FEDIVERSE_HANDLE_HOST: HANDLE_HOST }))).toThrow(
      /FEDIVERSE_HANDLE_HOST needs URL/
    )
  })
})

describe('the WebFinger check of the Fediverse page', () => {
  const saved = { url: process.env.URL, host: process.env.FEDIVERSE_HANDLE_HOST }
  afterAll(() => {
    for (const [name, value] of [
      ['URL', saved.url],
      ['FEDIVERSE_HANDLE_HOST', saved.host],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('asks for the CMS host by default and for the handle host when it is set', () => {
    process.env.URL = CMS_ORIGIN
    delete process.env.FEDIVERSE_HANDLE_HOST
    expect(webFingerSubject('bogdev', CMS_ORIGIN)).toBe('acct:bogdev@cms.example.test')

    process.env.FEDIVERSE_HANDLE_HOST = HANDLE_HOST
    expect(webFingerSubject('bogdev', CMS_ORIGIN)).toBe(`acct:bogdev@${HANDLE_HOST}`)
  })
})

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
  // `@bogdev@cms.example.test` stops resolving, which docs/FEDIVERSE.md says.
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
