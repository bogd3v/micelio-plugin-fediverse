import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Core } from '@strapi/strapi'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSite } from './helpers/sites'

import { cleanupStrapi, setupStrapi } from './strapi'

// The core is loaded as CommonJS, as Strapi loads it (see `helpers/sites.ts`).
const { missingLocales } = createRequire(import.meta.url)(
  '@micelio/strapi-plugin-core/strapi-server'
) as typeof import('@micelio/strapi-plugin-core/strapi-server')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = path.join(ROOT, '.tmp', `core-extensions-${process.env.VITEST_POOL_ID ?? '1'}`)
const FOLLOWER_UID = 'plugin::fediverse.follower'
const SITE_UID = 'plugin::micelio.site'
const PASSWORD = 'Core-ext-1'

interface Check {
  id: string
  status: string
  detail?: { en: string; es: string }
}
interface Registered {
  id: string
  label: { en: string; es: string }
  run(site: { documentId: string; slug: string }): Promise<Check[]>
}
describe('The extension points of the core: the Fediverse page, status checks and export section', () => {
  const saved = { ...process.env }
  let server: Core.Strapi['server']['httpServer']
  let readerToken: string
  let strangerToken: string
  let counter = 0

  const extensions = () =>
    strapi.plugin('micelio').service('extensions') as {
      adminPages(): Registered[]
      statusChecks(): Registered[]
      exportSections(): { id: string; version: string; personalData: boolean; permission: string }[]
      runStatusChecks(sites: { documentId: string; slug: string }[]): Promise<void>
    }
  const siteExport = () =>
    strapi.plugin('micelio').service('siteExport') as {
      export(request: { site: string; include?: string[] }, output: Writable): Promise<unknown>
      import(
        source: Readable,
        request?: { into?: string }
      ): Promise<{
        plugins: Record<string, { imported: number; skipped: number }>
        skippedPlugins: { id: string; reason: string }[]
      }>
    }
  const followers = () => strapi.plugin('fediverse').service('followers')

  async function adminWith(actions: string[]): Promise<string> {
    counter += 1
    const role = await strapi
      .service('admin::role')
      .create({ name: `Extensions role ${counter}`, description: 'test' })
    if (actions.length > 0) {
      await strapi.service('admin::role').assignPermissions(
        role.id,
        actions.map((action) => ({ action, subject: null, properties: {}, conditions: [] }))
      )
    }
    const email = `extensions-${counter}@example.test`
    await strapi.service('admin::user').create({
      email,
      password: PASSWORD,
      firstname: 'Ext',
      lastname: 'Admin',
      isActive: true,
      roles: [role.id],
    })
    const res = await request(server).post('/admin/login').send({ email, password: PASSWORD })
    return res.body.data.token ?? res.body.data.accessToken
  }

  /** The archive of a site as a file in the work folder, exported with the given sections. */
  async function exportArchive(slug: string, name: string, include?: string[]): Promise<string> {
    const file = path.join(WORK, `${name}.tgz`)
    const output = fs.createWriteStream(file)
    const done = new Promise<void>((resolve, reject) => {
      output.on('finish', resolve)
      output.on('error', reject)
    })
    await siteExport().export({ site: slug, ...(include ? { include } : {}) }, output)
    await done
    return file
  }

  const importArchive = (file: string, into: string) =>
    siteExport().import(fs.createReadStream(file), { into })
  const listing = (file: string): string[] =>
    execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const rowsOf = (site: string) =>
    strapi.db.query(FOLLOWER_UID).findMany({
      where: { site: { documentId: site } },
      orderBy: { actorId: 'asc' },
    }) as Promise<
      { actorId: string; handle: string | null; blocked: boolean; avatar: string | null }[]
    >

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FRONTEND_URL = 'https://blog.example.test'
    fs.rmSync(WORK, { recursive: true, force: true })
    fs.mkdirSync(WORK, { recursive: true })
    await setupStrapi()
    server = strapi.server.httpServer
    readerToken = await adminWith(['plugin::fediverse.read', 'plugin::micelio.status.read'])
    strangerToken = await adminWith(['plugin::micelio.status.read'])
  })

  afterAll(async () => {
    await cleanupStrapi()
    fs.rmSync(WORK, { recursive: true, force: true })
    process.env = saved
  })

  it('lists the Fediverse item in GET /micelio/admin-pages for a role with plugin::fediverse.read and not for a role without it', async () => {
    const listed = async (token: string) => {
      const res = await request(server)
        .get('/micelio/admin-pages')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
      return res.body.data as {
        id: string
        group: string
        to: string
        label: Registered['label']
      }[]
    }

    expect(await listed(readerToken)).toEqual([
      {
        id: 'fediverse',
        group: 'site',
        to: 'fediverse',
        label: { en: 'Fediverse', es: 'Fediverso' },
      },
    ])
    expect(await listed(strangerToken)).toEqual([])
  })

  it('returns a fail check with id webfinger and the code in detail for a site whose WebFinger is unreachable, and no figures', async () => {
    try {
      process.env.URL = 'http://127.0.0.1:1'
      const row = (await strapi.db
        .query('plugin::micelio.site')
        .findOne({ where: { isDefault: true }, select: ['documentId', 'slug'] })) as {
        documentId: string
        slug: string
      }

      await extensions().runStatusChecks([{ documentId: row.documentId, slug: row.slug }])
      const status = await request(server)
        .get('/micelio/status')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200)
      const result = status.body.data.plugins.fediverse as {
        label: Registered['label']
        checks: { id: string; status: string; site: string; detail?: { en: string; es: string } }[]
      }

      const webfinger = result.checks.find((check) => check.id === 'webfinger')
      expect(webfinger).toMatchObject({
        status: 'fail',
        site: row.documentId,
        detail: { en: 'webfinger-unreachable', es: 'webfinger-unreachable' },
      })
      expect(result.checks.map((check) => check.id).sort()).toEqual([
        'actor-key',
        'public-url',
        'webfinger',
      ])

      // The card is the caller's own: a role without `plugin::fediverse.read` does not get it.
      const hidden = await request(server)
        .get('/micelio/status')
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(200)
      expect(hidden.body.data.plugins.fediverse).toBeUndefined()
    } finally {
      delete process.env.URL
    }
  })

  it('runs the checks for the site given: its handle from its username and first host, and one id per check whatever the status', async () => {
    const asked: string[] = []
    const fake = http.createServer((req, res) => {
      const resource = new URL(req.url ?? '', 'http://x').searchParams.get('resource') ?? ''
      asked.push(resource)
      res.writeHead(200, { 'content-type': 'application/jrd+json' })
      res.end(JSON.stringify({ subject: resource }))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const site = await createSite('checks-b', {
      hosts: ['checks-b.example.test'],
      section_fediverse_actor: { identifier: 'checks-b' },
    })
    const run = () => extensions().statusChecks()[0].run({ documentId: site, slug: 'checks-b' })
    try {
      process.env.URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
      const found = await run()

      expect(asked).toEqual(['acct:checks-b@checks-b.example.test'])
      expect(found.find((check) => check.id === 'webfinger')).toMatchObject({ status: 'ok' })
      expect(found.map((check) => check.id)).toEqual(['public-url', 'actor-key', 'webfinger'])

      delete process.env.URL
      const failing = await run()

      expect(failing.map((check) => check.id)).toEqual(['public-url', 'actor-key', 'webfinger'])
      expect(failing.map((check) => check.detail?.en)).toEqual([
        'url-missing',
        'actor-key-missing',
        'webfinger-skipped',
      ])
    } finally {
      delete process.env.URL
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  it('uses the site asked for in the diagnostics of the Fediverse page too', async () => {
    const asked: string[] = []
    const fake = http.createServer((req, res) => {
      const resource = new URL(req.url ?? '', 'http://x').searchParams.get('resource') ?? ''
      asked.push(resource)
      res.writeHead(200, { 'content-type': 'application/jrd+json' })
      res.end(JSON.stringify({ subject: resource }))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    await createSite('page-b', {
      hosts: ['page-b.example.test'],
      section_fediverse_actor: { identifier: 'page-b' },
    })
    try {
      process.env.URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
      const res = await request(server)
        .get('/fediverse-panel/diagnostics?site=page-b')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200)

      expect(asked).toEqual(['acct:page-b@page-b.example.test'])
      const webfinger = (res.body.checks as { id: string; ok: boolean | null }[]).find(
        (check) => check.id === 'webfinger'
      )
      expect(webfinger?.ok).toBe(true)
    } finally {
      delete process.env.URL
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  describe('the export section', () => {
    const input = (name: string) => ({
      actorId: `https://remote.example.test/users/${name}`,
      handle: `@${name}@remote.example.test`,
      name: name.toUpperCase(),
      inbox: `https://remote.example.test/users/${name}/inbox`,
      avatar: `https://remote.example.test/avatars/${name}.png`,
    })
    const ANNA = 'https://remote.example.test/users/anna'
    const BRUNO = 'https://remote.example.test/users/bruno'

    /**
     * A site with two followers, one of them blocked, whose archive is exported and which is then
     * removed. The new site is made with the same actor identifier: the lock of the plugin refuses
     * an import that would change the identifier of a site that has one.
     */
    async function archiveOf(name: string, include?: string[]) {
      const identifier = `${name}-actor`
      const source = await createSite(`${name}-source`, {
        section_fediverse_actor: { identifier },
      })
      await followers().recordFollower(strapi, input('anna'), source)
      const bruno = await followers().recordFollower(strapi, input('bruno'), source)
      await followers().setActorBlocked(strapi, bruno.documentId, true, source)
      const file = await exportArchive(`${name}-source`, name, include)
      await strapi.documents(SITE_UID).delete({ documentId: source, locale: '*' })
      await strapi.db.query(FOLLOWER_UID).deleteMany({ where: { actorId: { $in: [ANNA, BRUNO] } } })
      const target = await createSite(`${name}-target`, { section_fediverse_actor: { identifier } })
      return { file, target, slug: `${name}-target` }
    }

    it('is registered with the manage permission, personal data and its own version', () => {
      expect(extensions().exportSections()).toEqual([
        {
          id: 'fediverse',
          version: '1.0',
          personalData: true,
          permission: 'plugin::fediverse.manage',
          write: expect.any(Function),
          read: expect.any(Function),
        },
      ])
    })

    it('restores the followers and blocks of an export with --include fediverse into a clean site', async () => {
      const { file, target, slug } = await archiveOf('restore', ['fediverse'])
      expect(listing(file)).toContain('plugins/fediverse/followers.json')
      // The followers travel in the section only, never as content of the core's archive.
      expect(listing(file).filter((entry) => /follower/.test(entry))).toEqual([
        'plugins/fediverse/followers.json',
      ])
      expect(await rowsOf(target)).toEqual([])

      const report = await importArchive(file, slug)

      expect(report.plugins.fediverse).toEqual({ imported: 2, skipped: 0 })
      expect(report.skippedPlugins).toEqual([])
      const rows = await rowsOf(target)
      expect(rows.map(({ actorId, handle, blocked }) => ({ actorId, handle, blocked }))).toEqual([
        { actorId: ANNA, handle: '@anna@remote.example.test', blocked: false },
        { actorId: BRUNO, handle: '@bruno@remote.example.test', blocked: true },
      ])
      // The minimum: the avatar is not in the archive.
      expect(rows.map((row) => row.avatar)).toEqual([null, null])
      // Importing again changes nothing.
      expect((await importArchive(file, slug)).plugins.fediverse).toEqual({
        imported: 2,
        skipped: 0,
      })
      expect(await rowsOf(target)).toHaveLength(2)
    })

    it('never lifts a block the target already holds', async () => {
      const { file, target, slug } = await archiveOf('lift', ['fediverse'])
      const anna = await followers().recordFollower(strapi, { actorId: ANNA }, target)
      await followers().setActorBlocked(strapi, anna.documentId, true, target)

      await importArchive(file, slug)

      const byActor = Object.fromEntries((await rowsOf(target)).map((row) => [row.actorId, row]))
      expect(byActor[ANNA].blocked).toBe(true)
      expect(byActor[BRUNO].blocked).toBe(true)
    })

    it('keeps the handle, name and inbox the target has when the archive has none', async () => {
      const target = await createSite('keep-target')
      await followers().recordFollower(strapi, input('dora'), target)
      const entries = [
        {
          path: 'followers.json',
          body: JSON.stringify({
            followers: [
              {
                actorId: 'https://remote.example.test/users/dora',
                handle: null,
                name: null,
                inbox: 'ftp://elsewhere.example.test/inbox',
                blocked: false,
              },
            ],
          }),
        },
      ]
      const section = extensions().exportSections()[0] as unknown as {
        read(
          site: { documentId: string; slug: string },
          entries: { path: string; body: string }[]
        ): Promise<{ imported: number; skipped: number }>
      }

      await section.read({ documentId: target, slug: 'keep-target' }, entries)

      const [row] = (await rowsOf(target)) as unknown as {
        handle: string
        name: string
        inbox: string
      }[]
      expect(row).toMatchObject({
        handle: '@dora@remote.example.test',
        name: 'DORA',
        inbox: 'https://remote.example.test/users/dora/inbox',
      })
    })

    it('skips an entry that is not a follower, and cleans what it keeps', async () => {
      const entries = [
        {
          path: 'followers.json',
          body: JSON.stringify({
            followers: [
              { actorId: 'javascript:alert(1)', blocked: false },
              { actorId: 'https://remote.example.test/users/ok', blocked: 'yes' },
              {
                actorId: 'https://remote.example.test/users/carla',
                handle: '@carla@remote\n.example.test',
                name: null,
                inbox: 'data:text/html,x',
                blocked: false,
              },
            ],
          }),
        },
      ]
      const target = await createSite('dirty-target')
      const section = extensions().exportSections()[0] as unknown as {
        read(
          site: { documentId: string; slug: string },
          entries: { path: string; body: string }[]
        ): Promise<{ imported: number; skipped: number }>
      }

      const report = await section.read({ documentId: target, slug: 'dirty-target' }, entries)

      expect(report).toEqual({ imported: 1, skipped: 2 })
      const [row] = (await rowsOf(target)) as unknown as { handle: string; inbox: string | null }[]
      expect(row.handle).toBe('@carla@remote .example.test')
      expect(row.inbox).toBeNull()
    })

    it('writes no plugins/fediverse/ without --include fediverse', async () => {
      const { file } = await archiveOf('plain')

      expect(listing(file).filter((entry) => entry.startsWith('plugins/'))).toEqual([])
      expect(listing(file).filter((entry) => /follower/.test(entry))).toEqual([])
      const manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', file, 'manifest.json'], { encoding: 'utf8' })
      ) as { plugins: unknown[] }
      expect(manifest.plugins).toEqual([])
    })

    it('reports a fediverse section of another major under skippedPlugins', async () => {
      const { file, target, slug } = await archiveOf('major', ['fediverse'])
      const folder = path.join(WORK, 'major-files')
      fs.mkdirSync(folder)
      execFileSync('tar', ['-xzf', file, '-C', folder])
      const manifestPath = path.join(folder, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        plugins: { id: string; version: string }[]
      }
      manifest.plugins.find((plugin) => plugin.id === 'fediverse')!.version = '2.0'
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      // Files only, as the core wants an archive: no directory entries.
      const names = execFileSync('find', ['.', '-type', 'f'], { cwd: folder, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((name) => name.replace(/^\.\//, ''))
      const other = path.join(WORK, 'major-2.tgz')
      execFileSync('tar', ['-czf', other, '-C', folder, ...names])

      const report = await importArchive(other, slug)

      expect(report.skippedPlugins).toEqual([{ id: 'fediverse', reason: 'version' }])
      expect(report.plugins.fediverse).toBeUndefined()
      expect(await rowsOf(target)).toEqual([])
    })
  })

  it('has the label of the admin page and status checks registrations in en and es', () => {
    const labels = [...extensions().adminPages(), ...extensions().statusChecks()]
    expect(labels.map(({ id }) => id)).toEqual(['fediverse', 'fediverse'])
    for (const { label } of labels) expect(missingLocales(label)).toEqual([])
  })
})
