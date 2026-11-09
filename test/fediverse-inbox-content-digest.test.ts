import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'
import { createRemoteActor, type RemoteActor } from './helpers/remote-actor'
import { waitUntil } from './helpers/wait-until'
import { isContentDigestCovered, parseSignatureInput } from '../server/src/inbox-signature-input'

const PARAMS = ';created=1700000000;keyid="https://remote.example.com/actor#main-key"'

describe('parseSignatureInput', () => {
  it('lists every signature label with whether it covers content-digest', () => {
    expect(
      parseSignatureInput(
        `sig1=("@method" "content-digest")${PARAMS}, sig2=("@method" "date")${PARAMS}`
      )
    ).toEqual([
      { label: 'sig1', coversContentDigest: true },
      { label: 'sig2', coversContentDigest: false },
    ])
  })

  it('skips the members Fedify does not treat as signatures', () => {
    expect(
      parseSignatureInput(
        [
          `sig1=("content-digest");keyid="k"`, // no created
          `sig2=("content-digest");created=1`, // no keyid
          `sig3=("content-digest");created="1";keyid="k"`, // created is a string
          `sig4="content-digest"${PARAMS}`, // not an inner list
          `sig6=("content-digest")`, // no parameters at all (Fedify throws on it)
          `sig5=("@method")${PARAMS}`,
        ].join(', ')
      )
    ).toEqual([{ label: 'sig5', coversContentDigest: false }])
  })

  it.each(['sig1=(', 'sig1=("content-digest"', '("content-digest")', 'sig1=("a")garbage'])(
    'answers null for the malformed header %j',
    (header) => {
      expect(parseSignatureInput(header)).toBeNull()
    }
  )
})

describe('isContentDigestCovered', () => {
  it.each([
    `sig1=("@method" "@target-uri" "@authority" "host" "date" "content-digest")${PARAMS}`,
    `sig1=("content-digest";sf)${PARAMS}`,
    `  sig1=("content-digest")${PARAMS}  `,
    `sig1=("content-digest")${PARAMS}, sig2=("@method" "content-digest")${PARAMS}`,
    `sig1=("content-digest")${PARAMS}, other=("@method");keyid="k"`,
    `sig1=("content-digest");keyid="k";created=1;alg="rsa-v1_5-sha256";tag="x"`,
  ])('accepts %j', (header) => {
    expect(isContentDigestCovered(header)).toBe(true)
  })

  it.each([
    [`sig1=("@method" "date")${PARAMS}`, 'no label covers it'],
    [`sig1=("content-digest")${PARAMS}, sig2=("@method")${PARAMS}`, 'one label skips it'],
    [`sig1=("Content-Digest")${PARAMS}`, 'component names are lower case'],
    [`sig1=(content-digest)${PARAMS}`, 'a token is not a component name'],
    [`sig1=("@method");tag="content-digest"${PARAMS}`, 'a parameter is not a component'],
    [`sig1=("content-digest")${PARAMS}, sig1=("@method")${PARAMS}`, 'the last duplicate wins'],
    [`sig1=("content-digest");keyid="k"`, 'no member is a signature'],
    ['', 'the header is empty'],
    ['sig1=("content-digest"', 'the header is malformed'],
  ])('refuses %j: %s', (header) => {
    expect(isContentDigestCovered(header)).toBe(false)
  })
})

describe('Fediverse inbox RFC 9421 Content-Digest coverage', () => {
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
    remote = await createRemoteActor({ preferredUsername: 'content-digest-test' })
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
  ])(
    'refuses an RFC 9421 Follow whose signature does not cover content-digest on %s',
    async (_label, inbox) => {
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
        res = await remote.postSignedActivity(inbox(), follow(), {
          rfc9421: { coverContentDigest: false },
        })
      } finally {
        spy.mockRestore()
      }

      expect(res.status).toBe(401)
      expect(await res.text()).toBe('The signature must cover the Content-Digest header.')
      expect(warnings).toContainEqual({
        message: 'security: fediverse.inbox.signature-refused',
        meta: expect.objectContaining({
          event: 'fediverse.inbox.signature-refused',
          outcome: 'failure',
          reason: 'content-digest-not-covered',
        }),
      })
      expect(await followerRow()).toBeNull()
      expect(accepts()).toEqual([])
    }
  )

  it.each([
    ['an RFC 9421 signature that covers content-digest', { rfc9421: {} }],
    ['a draft-cavage signature', undefined],
  ])('accepts a signed Follow with %s', async (_label, options) => {
    const res = await remote.postSignedActivity(`${actorUrl}/inbox`, follow(), options)

    expect(res.status).toBe(202)
    await waitUntil(followerRow)
    await waitUntil(() => accepts().length > 0)
  })
})
