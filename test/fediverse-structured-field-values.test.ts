/**
 * Guards the coupling between the plugin's `Signature-Input` parser and
 * Fedify's: both must load the same copy of `structured-field-values`, or the
 * pre-Fedify check could read a header differently from the verifier. See
 * `docs/FEDIVERSE.md`, "RFC 9421 signatures must cover `content-digest`".
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const PACKAGE = 'structured-field-values'
const ROOT = path.resolve(__dirname, '..')
// The plugin bundle keeps its packages external and loads them from here.
const PLUGIN_BUNDLE = path.join(ROOT, 'dist/strapi-server.js')

interface ResolvedPackage {
  root: string
  version: string
}

/** The real directory and version of the package an entry file belongs to. */
function packageOf(entry: string, name: string): ResolvedPackage {
  let dir = path.dirname(realpathSync(entry))
  for (;;) {
    const manifest = path.join(dir, 'package.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (isManifest(parsed) && parsed.name === name) return { root: dir, version: parsed.version }
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`no package.json named ${name} above ${entry}`)
    dir = parent
  }
}

function resolveFrom(fromFile: string, name: string): ResolvedPackage {
  return packageOf(createRequire(fromFile).resolve(name), name)
}

function isManifest(value: unknown): value is { name: string; version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'version' in value &&
    typeof value.name === 'string' &&
    typeof value.version === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

describe('structured-field-values shared with Fedify', () => {
  const fromRoot = resolveFrom(path.join(ROOT, 'package.json'), PACKAGE)
  const fromPlugin = resolveFrom(PLUGIN_BUNDLE, PACKAGE)
  const fedify = resolveFrom(path.join(ROOT, 'package.json'), '@fedify/fedify')
  const fromFedify = resolveFrom(path.join(fedify.root, 'package.json'), PACKAGE)

  it('is the exact version pinned in package.json', () => {
    const manifest: unknown = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const dependencies = isRecord(manifest) ? manifest.dependencies : undefined
    expect(fromRoot.version).toBe(isRecord(dependencies) ? dependencies[PACKAGE] : undefined)
  })

  it('resolves to the same copy from the plugin bundle and from @fedify/fedify', () => {
    expect(fromPlugin).toEqual(fromRoot)
    expect(fromFedify).toEqual(fromRoot)
  })
})
