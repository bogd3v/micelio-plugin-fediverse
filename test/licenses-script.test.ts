import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/check-licenses.mjs', import.meta.url))
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-'))

/** Runs the licence check on a lockfile that holds `packages` (the root is always there). */
function check(packages: Record<string, { version: string; license?: string }>): {
  status: number | null
  stderr: string
} {
  const lock = path.join(TEMP, `lock-${Object.keys(packages).join('_').replace(/\W/g, '')}.json`)
  fs.writeFileSync(lock, JSON.stringify({ packages: { '': { name: 'root' }, ...packages } }))
  const { status, stderr } = spawnSync('node', [SCRIPT, '--lock', lock], { encoding: 'utf8' })
  return { status, stderr }
}

describe('lint:licenses', () => {
  afterAll(() => {
    fs.rmSync(TEMP, { recursive: true, force: true })
  })

  it('passes a production dependency under an allowed licence', () => {
    expect(check({ 'node_modules/fine': { version: '1.0.0', license: 'MIT' } }).status).toBe(0)
  })

  it('fails a production dependency with no licence field and no exception', () => {
    const result = check({ 'node_modules/unlicensed': { version: '1.0.0' } })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unlicensed@1.0.0 (no license field)')
  })

  it('passes the dependency with no licence field that has a reasoned exception', () => {
    expect(check({ 'node_modules/only': { version: '0.0.2' } }).status).toBe(0)
  })

  it('fails a later version of the dependency that has a reasoned exception', () => {
    const result = check({ 'node_modules/only': { version: '0.0.3' } })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('only@0.0.3 (no license field)')
  })

  it('fails a licence that is not on the allowlist', () => {
    const result = check({ 'node_modules/closed': { version: '1.0.0', license: 'UNLICENSED' } })

    expect(result.status).toBe(1)
  })
})
