import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Core } from '@strapi/strapi'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { cleanupStrapi, setupStrapi } from './strapi'

// The package as npm publishes it: packed, unpacked into a node_modules folder, and loaded by a
// clean Strapi the way a host loads it (`./strapi-server` of the installed package). The folder
// sits inside the repository so the dependencies resolve from its `node_modules`.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK_DIR = path.join(ROOT, '.tmp', `pack-${process.env.VITEST_POOL_ID ?? '1'}`)
const INSTALLED = path.join(PACK_DIR, 'node_modules', ...packageJson.name.split('/'))

interface PackResult {
  filename: string
  files: { path: string }[]
}

describe('the packed package', () => {
  let packed: PackResult
  let strapi: Core.Strapi

  beforeAll(async () => {
    fs.rmSync(PACK_DIR, { recursive: true, force: true })
    fs.mkdirSync(INSTALLED, { recursive: true })
    // `--ignore-scripts`: the global setup has built `dist/`, and `prepack` would rebuild it under
    // the suites that are loading it. That `prepack` builds is the second test's job.
    const output = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', PACK_DIR],
      { cwd: ROOT, encoding: 'utf8' }
    )
    packed = (JSON.parse(output) as PackResult[])[0]
    execFileSync('tar', [
      '-xzf',
      path.join(PACK_DIR, packed.filename),
      '-C',
      INSTALLED,
      '--strip-components=1',
    ])

    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'blog'
    process.env.FEDIVERSE_PLUGIN_PATH = INSTALLED
    strapi = await setupStrapi()
  })

  afterAll(async () => {
    await cleanupStrapi()
    delete process.env.FEDIVERSE_PLUGIN_PATH
    fs.rmSync(PACK_DIR, { recursive: true, force: true })
  })

  it('declares the core release line it supports and its plugin name', () => {
    expect(packageJson.micelio).toMatch(/^\d+\.\d+$/)
    expect(packageJson.strapi).toMatchObject({ kind: 'plugin', name: 'fediverse' })
  })

  it('the packed package declares micelio 0.7 and ships dist/strapi-server.js and dist/strapi-admin', () => {
    const files = packed.files.map((file) => file.path)
    expect(packageJson.micelio).toBe('0.7')
    expect(packageJson.version).toMatch(/^0\.7\.\d+$/)
    expect('private' in packageJson).toBe(false)
    const packedManifest = JSON.parse(
      fs.readFileSync(path.join(INSTALLED, 'package.json'), 'utf8')
    ) as { micelio?: string }
    expect(packedManifest.micelio).toBe('0.7')
    expect(files).toEqual(
      expect.arrayContaining([
        'dist/strapi-server.js',
        'dist/strapi-admin.mjs',
        'dist/strapi-admin.js',
      ])
    )
  })

  it('builds the plugin before npm packs it, because the publish job runs no build', () => {
    expect(packageJson.scripts.prepack).toBe('npm run build')
  })

  it('ships the server bundle and the licences, and no source or test', () => {
    const files = packed.files.map((file) => file.path)
    expect(files).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'LICENSES/AGPL-3.0-only.txt',
        'THIRD-PARTY.md',
        'package.json',
        'dist/strapi-server.js',
      ])
    )
    expect(
      files.filter((file) => /^(test|server|admin|scripts)\//.test(file) || file.endsWith('.map'))
    ).toEqual([])
  })

  it('ships the admin entry as the ./strapi-admin export, for Strapi to bundle', () => {
    const files = packed.files.map((file) => file.path)
    expect(files).toEqual(expect.arrayContaining(['dist/strapi-admin.mjs', 'dist/strapi-admin.js']))
    expect(packageJson.exports['./strapi-admin']).toEqual({
      import: './dist/strapi-admin.mjs',
      require: './dist/strapi-admin.js',
      default: './dist/strapi-admin.js',
    })
    for (const file of ['dist/strapi-admin.mjs', 'dist/strapi-admin.js']) {
      expect(fs.existsSync(path.join(INSTALLED, file)), file).toBe(true)
    }
  })

  it('loads the plugin from the unpacked tarball, under the name fediverse', () => {
    const enabled =
      strapi.config.get<Record<string, { packageInfo?: { name?: string }; pathToPlugin?: string }>>(
        'enabledPlugins'
      )
    expect(enabled.fediverse?.packageInfo?.name).toBe(packageJson.name)
    expect(fs.realpathSync(enabled.fediverse?.pathToPlugin ?? '')).toBe(fs.realpathSync(INSTALLED))
  })

  it('registers the content types of the plugin under the UIDs hosts already store', () => {
    for (const uid of [
      'plugin::fediverse.follower',
      'plugin::fediverse.interaction',
      'plugin::fediverse.federated-article',
    ]) {
      expect(strapi.contentType(uid as never), uid).toBeDefined()
    }
  })

  it('registers the permission actions of the plugin', () => {
    const actions = strapi.service('admin::permission').actionProvider.keys() as string[]
    expect(actions).toEqual(
      expect.arrayContaining(['plugin::fediverse.read', 'plugin::fediverse.manage'])
    )
  })
})
