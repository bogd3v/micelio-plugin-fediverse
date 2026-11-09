import { describe, it, expect, afterEach } from 'vitest'
import { setupStrapi, cleanupStrapi } from './strapi'
import { assertNoRemovedActorVariables } from '../server/src/utils/removed-variables'

const REMOVED = [
  ['FEDIVERSE_ACTOR_USERNAME', 'Username'],
  ['FEDIVERSE_ACTOR_NAME', 'Display name'],
  ['FEDIVERSE_ACTOR_SUMMARY', 'Summary'],
  ['FEDIVERSE_ACTOR_SOURCE_URL', 'Source URL'],
] as const

describe('Removed FEDIVERSE_ACTOR_* variables (#307)', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it.each(REMOVED)('%s stops the boot, naming "%s" under the default site', (name, field) => {
    expect(() => assertNoRemovedActorVariables({ [name]: 'anything' })).toThrow(
      `[fediverse] ${name} is no longer read: set "${field}" under the default site's Fediverse profile`
    )
  })

  it('names every variable that is set, once', () => {
    let message = ''
    try {
      assertNoRemovedActorVariables({
        FEDIVERSE_ACTOR_USERNAME: 'blog',
        FEDIVERSE_ACTOR_SUMMARY: 'A bio',
        FEDIVERSE_ACTOR_NAME: ' ',
      })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('FEDIVERSE_ACTOR_USERNAME')
    expect(message).toContain('FEDIVERSE_ACTOR_SUMMARY')
    expect(message).not.toContain('FEDIVERSE_ACTOR_NAME')
    expect(message).not.toContain('FEDIVERSE_ACTOR_SOURCE_URL')
  })

  it('accepts a blank or unset variable and the identifier', () => {
    expect(() =>
      assertNoRemovedActorVariables({
        FEDIVERSE_ACTOR_NAME: '  ',
        FEDIVERSE_ACTOR_IDENTIFIER: 'blog',
      })
    ).not.toThrow()
    expect(() => assertNoRemovedActorVariables({})).not.toThrow()
  })

  it('stops a real boot with FEDIVERSE_ACTOR_USERNAME set, naming the setting', async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    process.env.FEDIVERSE_ACTOR_USERNAME = 'bogdev'
    process.env.FRONTEND_URL = 'https://blog.example.test'

    try {
      await expect(setupStrapi()).rejects.toThrow(
        `FEDIVERSE_ACTOR_USERNAME is no longer read: set "Username" under the default site's Fediverse profile`
      )
    } finally {
      await cleanupStrapi()
    }
  })
})
