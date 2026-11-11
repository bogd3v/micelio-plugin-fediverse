import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { setFediverseUsername } from './helpers/fediverse-profile'
import {
  createSite,
  CUT_OVER_KEY,
  CUT_OVER_STORE,
  readSite,
  setHosts,
  jsonOf,
} from './helpers/sites'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'

const { SITE_UID } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

describe('The 0.7 boot step pins the handle host 0.6 served', () => {
  // The plugin as Strapi loaded it (the built bundle reads the variables after the test set them).
  const runCutOver = (instance: typeof strapi) =>
    instance.plugin('fediverse').service('cut-over').runCutOver(instance) as Promise<void>
  const saved = { ...process.env }
  const store = () => strapi.store(CUT_OVER_STORE)
  const marker = () => store().get({ key: CUT_OVER_KEY })
  const hosts = async () => (await readSite()).hosts
  const webfinger = async (acct: string) => {
    const res = await fetch(
      `http://${serverHost()}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`
    )
    return { status: res.status, body: await jsonOf(res) }
  }

  /** The default site as 0.6 left it: the given hosts, no identifier, no marker, no other site. */
  async function as06(initialHosts: string[]): Promise<void> {
    for (const row of (await strapi.db
      .query(SITE_UID)
      .findMany({ where: { isDefault: false }, select: ['documentId'] })) as {
      documentId: string
    }[]) {
      await strapi.documents(SITE_UID).delete({ documentId: row.documentId })
    }
    await setHosts(initialHosts)
    await store().delete({ key: CUT_OVER_KEY })
  }

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.URL = 'https://cms.example.com'
    process.env.FRONTEND_URL = 'https://example.com'
    delete process.env.FEDIVERSE_HANDLE_HOST
    await setupStrapi()
    await setFediverseUsername('bogdev')
  })

  beforeEach(() => {
    delete process.env.FEDIVERSE_HANDLE_HOST
    process.env.FRONTEND_URL = 'https://example.com'
  })

  afterAll(async () => {
    await cleanupStrapi()
    process.env = saved
  })

  it('pins FEDIVERSE_HANDLE_HOST as hosts[0] of an empty list, and a second boot changes nothing', async () => {
    process.env.FEDIVERSE_HANDLE_HOST = 'example.com'
    process.env.FRONTEND_URL = 'https://blog.example.com'
    await as06([])

    await runCutOver(strapi)
    expect(await hosts()).toEqual(['example.com', 'blog.example.com'])
    expect(await marker()).toBe(true)
    expect((await readSite()).identifier).toBe('devbog')

    await cleanupStrapi({ keepDatabase: true })
    await setupStrapi({ keepDatabase: true })
    expect(await hosts()).toEqual(['example.com', 'blog.example.com'])
    expect((await webfinger('bogdev@example.com')).status).toBe(200)
  })

  it("keeps the operator's order of hosts on a later boot with FEDIVERSE_HANDLE_HOST set, and logs the warning", async () => {
    process.env.FEDIVERSE_HANDLE_HOST = 'example.com'
    await as06([])
    await runCutOver(strapi)

    await setHosts(['www.example.com', 'example.com'])
    const warn = vi.spyOn(strapi.log, 'warn')
    await runCutOver(strapi)

    expect(await hosts()).toEqual(['www.example.com', 'example.com'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FEDIVERSE_HANDLE_HOST'))
    warn.mockRestore()
  })

  it('moves FEDIVERSE_HANDLE_HOST to the front of a filled hosts list', async () => {
    process.env.FEDIVERSE_HANDLE_HOST = 'example.com'
    process.env.FRONTEND_URL = 'https://www.example.com'
    await as06(['www.example.com'])

    await runCutOver(strapi)

    expect(await hosts()).toEqual(['example.com', 'www.example.com'])
  })

  it('stops the boot naming FEDIVERSE_HANDLE_HOST when another site holds the handle host', async () => {
    process.env.FEDIVERSE_HANDLE_HOST = 'example.com'
    await as06([])
    await createSite('other', { hosts: ['example.com'] })

    await expect(runCutOver(strapi)).rejects.toThrow(/FEDIVERSE_HANDLE_HOST/)

    // Nothing half-done: no host written and no marker.
    expect(await hosts()).toEqual([])
    expect(await marker()).toBeFalsy()
  })

  it('only logs when another site holds the host of FRONTEND_URL', async () => {
    process.env.FEDIVERSE_HANDLE_HOST = 'example.com'
    process.env.FRONTEND_URL = 'https://blog.example.com'
    await as06([])
    await createSite('other', { hosts: ['blog.example.com'] })
    const info = vi.spyOn(strapi.log, 'info')

    await runCutOver(strapi)

    expect(await hosts()).toEqual(['example.com'])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('FRONTEND_URL'))
    expect(await marker()).toBe(true)
    info.mockRestore()
  })

  it('keeps the handle on the host of URL when FEDIVERSE_HANDLE_HOST is unset and hosts is empty', async () => {
    await as06([])

    await runCutOver(strapi)

    expect(await hosts()).toEqual(['cms.example.com', 'example.com'])
    const found = await webfinger('bogdev@cms.example.com')
    expect(found.status).toBe(200)
    expect(found.body.subject).toBe('acct:bogdev@cms.example.com')
  })

  it('keeps the handle on the host of URL when hosts was filled on 0.6', async () => {
    await as06(['example.com'])

    await runCutOver(strapi)

    expect(await hosts()).toEqual(['cms.example.com', 'example.com'])
    expect((await webfinger('bogdev@cms.example.com')).status).toBe(200)
  })

  it('stops the boot naming URL when another site holds the host of URL', async () => {
    await as06([])
    await createSite('other', { hosts: ['cms.example.com'] })

    await expect(runCutOver(strapi)).rejects.toThrow(/\bURL\b/)

    expect(await hosts()).toEqual([])
    expect(await marker()).toBeFalsy()
  })

  it("does nothing when the package's bootstrap runs before the core's, and sets identifier on the next boot", async () => {
    await as06([])
    // The instance had no site yet: the core creates the default one in its own bootstrap.
    await strapi.db.query(SITE_UID).deleteMany({ where: { id: { $notNull: true } } })

    await cleanupStrapi({ keepDatabase: true })
    await setupStrapi({ keepDatabase: true })

    // The precondition of the test: Strapi bootstraps the plugins in this order.
    const order = Object.keys(strapi.plugins)
    expect(order.indexOf('fediverse')).toBeLessThan(order.indexOf('micelio'))
    // The package's bootstrap found no site: nothing written, no marker.
    expect((await readSite()).identifier).toBeNull()
    expect(await hosts()).toEqual([])
    expect(await marker()).toBeFalsy()

    await cleanupStrapi({ keepDatabase: true })
    await setupStrapi({ keepDatabase: true })

    expect((await readSite()).identifier).toBe('devbog')
    expect(await hosts()).toEqual(['cms.example.com', 'example.com'])
    expect(await marker()).toBe(true)
  })
})
