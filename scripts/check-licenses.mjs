// Fails on production dependencies whose licence is not on the allowlist of @micelio/eslint-config
// (ADR 0007, AGPL-3.0-only). Dev dependencies are not distributed: they only warn.
//
//   node scripts/check-licenses.mjs [--lock path/to/package-lock.json] [--summary]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { allowed, allowedPrefixes, allowedGpl2 } = require('@micelio/eslint-config/licenses.json')

function idAllowed(id) {
  if (allowedGpl2.includes(id)) return true
  const name = id.replace(/\+$/, '')
  return allowed.includes(name) || allowedPrefixes.some((prefix) => name.startsWith(prefix))
}

// SPDX expression: OR passes if one side is allowed, AND needs all, `X WITH exception` is judged
// by X. Anything malformed (unknown token, unbalanced parentheses) fails.
function evaluate(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  let malformed = false
  const keyword = (token) => ['AND', 'OR', 'WITH'].includes(token?.toUpperCase())
  function parseOr() {
    let value = parseAnd()
    while (tokens[i]?.toUpperCase() === 'OR') {
      i++
      const right = parseAnd()
      value = value || right
    }
    return value
  }
  function parseAnd() {
    let value = parseWith()
    while (tokens[i]?.toUpperCase() === 'AND') {
      i++
      const right = parseWith()
      value = value && right
    }
    return value
  }
  function parseWith() {
    const value = parseAtom()
    if (tokens[i]?.toUpperCase() === 'WITH') {
      i++
      const exception = tokens[i++]
      if (exception === undefined || exception === '(' || exception === ')' || keyword(exception)) {
        malformed = true
      }
    }
    return value
  }
  function parseAtom() {
    const token = tokens[i++]
    if (token === '(') {
      const value = parseOr()
      if (tokens[i++] !== ')') malformed = true
      return value
    }
    if (token === undefined || token === ')' || keyword(token)) {
      malformed = true
      return false
    }
    return idAllowed(token)
  }
  const result = parseOr()
  return result && !malformed && i === tokens.length
}

function licenseOf(meta) {
  const license = meta.license
  if (!license) return null
  if (typeof license === 'string') return license
  if (Array.isArray(license)) return `(${license.map((entry) => entry.type ?? entry).join(' OR ')})`
  return license.type ?? null
}

function main() {
  const flag = process.argv.indexOf('--lock')
  const lockPath =
    flag === -1 ? new URL('../package-lock.json', import.meta.url) : process.argv[flag + 1]
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const counts = {}
  const failures = []
  const warnings = []
  for (const [path, meta] of Object.entries(lock.packages)) {
    // The root and the workspace links are this repository's own packages, not dependencies.
    if (path === '' || meta.link) continue
    const name = path.replace(/^.*node_modules\//, '')
    const license = licenseOf(meta)
    counts[license ?? 'UNKNOWN'] = (counts[license ?? 'UNKNOWN'] ?? 0) + 1
    if (license && evaluate(license)) continue
    const entry = `${name}@${meta.version} (${license ?? 'no license field'})${meta.dev ? ' [dev]' : ''}`
    ;(meta.dev ? warnings : failures).push(entry)
  }

  if (process.argv.includes('--summary')) console.log(counts)
  for (const warning of new Set(warnings)) console.warn(`warn: ${warning}`)
  if (failures.length) {
    for (const failure of new Set(failures)) console.error(`error: ${failure}`)
    console.error(
      'Remove the dependency, or change the allowlist in @micelio/eslint-config (ADR 0007).'
    )
    process.exit(1)
  }
  console.log('Licenses ok: every production dependency is AGPL-3.0 compatible.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
