// Computes the next release from the pull request titles merged since the last release tag
// (ADR 0010, sections 1 and 4). Prints JSON; the Release workflow reads it.
//
//   node scripts/release/version.mjs [--rc]
//
// Needs full tag history and an authenticated `gh` to read the titles.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const RC_TAG = /^v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/
const TITLE = /^([a-z]+)(?:\([^)]*\))?(!)?:/
// The dated snapshot tags (v2026.10.02) look like SemVer; no real MAJOR gets near this.
const DATED_MAJOR = 2000

/**
 * Bump a set of titles asks for, the highest wins: `!` is breaking, `feat` adds, the rest fixes.
 * @param {string[]} titles
 * @returns {'major' | 'minor' | 'patch' | null} `null` when there are no titles
 */
export function bumpFor(titles) {
  let bump = null
  for (const title of titles) {
    const match = TITLE.exec(title)
    if (match?.[2]) return 'major'
    bump = match?.[1] === 'feat' ? 'minor' : (bump ?? 'patch')
  }
  return bump
}

/**
 * Applies a bump. Before 1.0.0 a breaking change raises MINOR and everything else raises PATCH.
 * @param {string} version stable `X.Y.Z`
 * @param {'major' | 'minor' | 'patch'} bump
 * @returns {string}
 */
export function applyBump(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number)
  if (major === 0) return bump === 'major' ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/**
 * The newest stable `vX.Y.Z` tag, ignoring dated snapshots and release candidates.
 * @param {string[]} tags
 * @returns {string | null}
 */
export function lastStableTag(tags) {
  const stable = tags
    .map((tag) => ({ tag, match: STABLE_TAG.exec(tag) }))
    .filter(({ match }) => match && Number(match[1]) < DATED_MAJOR)
    .map(({ tag, match }) => ({ tag, parts: match.slice(1).map(Number) }))
    .sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2])
  return stable.at(-1)?.tag ?? null
}

/**
 * Plans the next release.
 * @param {object} input
 * @param {string} input.packageVersion `version` of `package.json`, the first release when no stable tag exists
 * @param {string[]} input.tags every tag of the repository
 * @param {string[]} input.titles titles of the pull requests merged since the last stable tag
 * @param {boolean} [input.rc] plan a release candidate of the next version
 * @returns {{ previous: string | null, bump: string | null, version: string, tag: string, prerelease: boolean }}
 * @throws {Error} when there is a previous release and nothing was merged since
 */
export function planRelease({ packageVersion, tags, titles, rc = false }) {
  const previous = lastStableTag(tags)
  let bump = null
  let base = packageVersion
  if (previous) {
    bump = bumpFor(titles)
    if (!bump) throw new Error(`Nothing merged since ${previous}`)
    base = applyBump(previous.slice(1), bump)
  }
  if (!rc) return { previous, bump, version: base, tag: `v${base}`, prerelease: false }
  const taken = tags
    .map((tag) => RC_TAG.exec(tag))
    .filter((match) => match && match.slice(1, 4).join('.') === base)
    .map((match) => Number(match[4]))
  const version = `${base}-rc.${Math.max(0, ...taken) + 1}`
  return { previous, bump, version, tag: `v${version}`, prerelease: true }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

function mergedPullRequests(previous) {
  const range = previous ? [`${previous}..HEAD`] : ['HEAD']
  const log = run('git', ['log', '--first-parent', '--format=%s', ...range])
  const numbers = log.split('\n').flatMap((subject) => {
    const match = /^Merge pull request #(\d+)/.exec(subject) ?? /\(#(\d+)\)$/.exec(subject)
    return match ? [Number(match[1])] : []
  })
  return numbers.map((number) => ({
    number,
    title: JSON.parse(
      run('gh', [
        'pr',
        'view',
        String(number),
        '--json',
        'title',
        ...(process.env.GITHUB_REPOSITORY ? ['--repo', process.env.GITHUB_REPOSITORY] : []),
      ])
    ).title,
  }))
}

function main() {
  const rc = process.argv.includes('--rc')
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
  const tags = run('git', ['tag', '-l']).split('\n').filter(Boolean)
  const previous = lastStableTag(tags)
  const pullRequests = previous ? mergedPullRequests(previous) : []
  const plan = planRelease({ packageVersion, tags, titles: pullRequests.map((pr) => pr.title), rc })
  const breaking = pullRequests.filter((pr) => bumpFor([pr.title]) === 'major').length
  console.log(JSON.stringify({ ...plan, packageVersion, breaking, pullRequests }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
