import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { isInboxDigestAccepted, parseDigestHeader } from '../server/src/inbox-digest'

describe('parseDigestHeader', () => {
  it('splits entries at the first "=", lower-cases the algorithm and trims both parts', () => {
    expect(parseDigestHeader(' SHA-256 = YWJj== ,sha-512=ZGVm')).toEqual([
      { algorithm: 'sha-256', value: 'YWJj==' },
      { algorithm: 'sha-512', value: 'ZGVm' },
    ])
  })

  it('skips empty entries and keeps an entry without a value', () => {
    expect(parseDigestHeader(', ,SHA, SHA-256=,')).toEqual([
      { algorithm: 'sha', value: '' },
      { algorithm: 'sha-256', value: '' },
    ])
  })

  it('gives no entries for an empty header', () => {
    expect(parseDigestHeader('   ')).toEqual([])
  })
})

describe('isInboxDigestAccepted', () => {
  it.each([
    'SHA-256=YWJj',
    'sha-256=YWJj',
    'Sha-512=YWJj',
    '  SHA-256=YWJj  ',
    'SHA-256=YWJj, SHA-512=ZGVm',
    'SHA-256=YWJj,',
  ])('accepts %j', (header) => {
    expect(isInboxDigestAccepted(header)).toBe(true)
  })

  it.each([
    'SHA=YWJj',
    'sha=YWJj',
    'MD5=YWJj',
    'SHA-1=YWJj',
    'UNIXsum=1',
    'SHA-256=',
    'SHA-256',
    '',
    ' , ',
    'SHA-256YWJj',
  ])('refuses %j, which has no SHA-256 or SHA-512 value', (header) => {
    expect(isInboxDigestAccepted(header)).toBe(false)
  })

  it.each([
    'SHA=YWJj, SHA-256=ZGVm',
    'SHA-512=ZGVm, sha=YWJj',
    'SHA-256=ZGVm, MD5=YWJj',
    'UNIXsum=1, SHA-256=ZGVm',
  ])('accepts %j: an approved entry next to another algorithm', (header) => {
    expect(isInboxDigestAccepted(header)).toBe(true)
  })
})

describe('Fediverse inbox Digest algorithms', () => {
  let host: string
  let actorUrl: string
  let remote: RemoteActor
  let followCount = 0

  const follow = () => ({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${remote.actorUrl}/follows/${++followCount}`,
    type: 'Follow',
    actor: remote.actorUrl,
    object: actorUrl,
  })
  const followerRow = () =>
    strapi.db.query('plugin::fediverse.follower').findOne({ where: { actorId: remote.actorUrl } })
  const accepts = () => remote.inboxDeliveries.filter((activity) => activity.type === 'Accept')

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = process.env.FEDIVERSE_ACTOR_IDENTIFIER || 'devbog'
    await setupStrapi()
    host = serverHost()
    actorUrl = `http://${host}/fediverse/user/devbog`
    remote = await createRemoteActor({ preferredUsername: 'digest-test' })
  })

  afterAll(async () => {
    await remote?.close()
    await cleanupStrapi()
  })

  afterEach(async () => {
    await strapi.db
      .query('plugin::fediverse.follower')
      .deleteMany({ where: { actorId: remote.actorUrl } })
    remote.inboxDeliveries.length = 0
  })

  it.each([
    ['the actor inbox', () => `${actorUrl}/inbox`],
    ['the shared inbox', () => `http://${host}/fediverse/inbox`],
  ])('refuses a signed Follow with a SHA-1-only Digest on %s', async (_label, inbox) => {
    const warnings: { message: string; meta: unknown }[] = []
    const spy = vi.spyOn(strapi.log, 'warn').mockImplementation(((
      message: unknown,
      meta: unknown
    ) => {
      warnings.push({ message: String(message), meta })
      return strapi.log
    }) as never)
    let res: Response
    try {
      res = await remote.postSignedActivity(inbox(), follow(), { digest: ['SHA'] })
    } finally {
      spy.mockRestore()
    }

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('The Digest header must use SHA-256 or SHA-512.')
    // Refused before Fedify runs: nothing was handed on that could record a follower.
    expect(warnings).toContainEqual({
      message: 'security: fediverse.inbox.signature-refused',
      meta: expect.objectContaining({
        event: 'fediverse.inbox.signature-refused',
        outcome: 'failure',
        reason: 'digest-algorithm',
      }),
    })
    expect(await followerRow()).toBeNull()
    expect(accepts()).toEqual([])
  })

  it.each([
    ['the default SHA-256 Digest', undefined],
    ['a SHA-512 Digest', ['SHA-512'] as const],
    ['a SHA-256 and SHA-512 Digest', ['SHA-256', 'SHA-512'] as const],
    ['a Digest that lists SHA-1 next to SHA-256', ['SHA', 'SHA-256'] as const],
  ])('accepts a signed Follow with %s', async (_label, digest) => {
    const res = await remote.postSignedActivity(
      `${actorUrl}/inbox`,
      follow(),
      digest ? { digest } : undefined
    )

    expect(res.status).toBe(202)
    await waitUntil(followerRow)
    await waitUntil(() => accepts().length > 0)
  })
})
