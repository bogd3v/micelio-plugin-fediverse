import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { setFediverseUsername } from './helpers/fediverse-profile'
import { createSite, readSite, SECTION } from './helpers/sites'
import { setupStrapi, cleanupStrapi, serverHost } from './strapi'

const SITE_UID = 'plugin::micelio.site'
const PASSWORD = 'Lock-admin-1'

describe('The username of a site cannot change while its actor has followers', () => {
  const saved = { ...process.env }
  let token: string

  const server = () => strapi.server.httpServer
  /** An edit of the site in the Content Manager, as an admin user makes it. */
  const edit = (documentId: string, data: Record<string, unknown>) =>
    request(server())
      .put(`/content-manager/collection-types/${SITE_UID}/${documentId}`)
      .query({ locale: 'en' })
      .set({ Authorization: `Bearer ${token}` })
      .send(data)
  const webfinger = (acct: string) =>
    fetch(
      `http://${serverHost()}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`
    )

  beforeAll(async () => {
    process.env.FEDIVERSE_ENABLED = 'true'
    process.env.FEDIVERSE_ACTOR_IDENTIFIER = 'devbog'
    await setupStrapi()
    await setFediverseUsername('bogdev')

    const superAdmin = await strapi.service('admin::role').getSuperAdmin()
    await strapi.service('admin::user').create({
      email: 'lock-super@example.test',
      password: PASSWORD,
      firstname: 'Lock',
      lastname: 'Super',
      isActive: true,
      roles: [superAdmin.id],
    })
    const login = await request(server())
      .post('/admin/login')
      .send({ email: 'lock-super@example.test', password: PASSWORD })
      .expect(200)
    token = login.body.data.token ?? login.body.data.accessToken
  })

  afterAll(async () => {
    await cleanupStrapi()
    process.env = saved
  })

  it('answers 409 username-locked to a change of the username of a site whose actor has a follower', async () => {
    const { documentId } = await readSite()
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: 'https://remote.example/users/locker' })

    const res = await edit(documentId, { fediverse: { username: 'renamed' } })

    expect(res.status).toBe(409)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body).toMatchObject({ status: 409, code: 'username-locked' })
    expect((await readSite()).fediverse?.username).toBe('bogdev')

    // The same value is not a change, so the edit of anything else goes through.
    await edit(documentId, { fediverse: { username: 'bogdev' }, tagline: 'Fine' }).expect(200)

    await strapi.db
      .query('plugin::fediverse.follower')
      .deleteMany({ where: { id: { $notNull: true } } })
  })

  it('changes the username of a site with no follower, and WebFinger answers the new name', async () => {
    const { documentId } = await readSite()

    await edit(documentId, { fediverse: { username: 'renamed' } }).expect(200)

    expect((await readSite()).fediverse?.username).toBe('renamed')
    expect((await webfinger(`renamed@${serverHost()}`)).status).toBe(200)
  })

  it('answers 409 identifier-locked to a change of an actor identifier that is set', async () => {
    const second = await createSite('lock-b')
    expect((await readSite(second)).identifier).toBe('lock-b')

    const res = await edit(second, { [SECTION]: { identifier: 'moved' } })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'identifier-locked' })
    expect((await readSite(second)).identifier).toBe('lock-b')
  })

  it('counts a write by what it leaves: a component written without its id empties the username', async () => {
    const { documentId } = await readSite()
    await setFediverseUsername('renamed')
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: 'https://remote.example/users/partial' })
    const stored = (await strapi.db
      .query(SITE_UID)
      .findOne({ where: { documentId }, populate: { fediverse: true } })) as {
      fediverse: { id: number; username: string }
    }
    expect(stored.fediverse.username).toBe('renamed')

    // Strapi replaces a component written without its id: the username would become empty.
    const without = await edit(documentId, { fediverse: { displayName: 'Only a name' } })
    expect(without.status).toBe(409)
    expect(without.body).toMatchObject({ code: 'username-locked' })
    expect((await readSite()).fediverse?.username).toBe('renamed')

    // With the id it is updated in place and the username stays.
    await edit(documentId, {
      fediverse: { id: stored.fediverse.id, displayName: 'A name' },
    }).expect(200)
    expect((await readSite()).fediverse?.username).toBe('renamed')
    await strapi.db
      .query('plugin::fediverse.follower')
      .deleteMany({ where: { id: { $notNull: true } } })
  })

  it('refuses to empty an identifier by writing the section without it', async () => {
    const second = await createSite('lock-empty')

    const res = await edit(second, { [SECTION]: {} })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'identifier-locked' })
    expect((await readSite(second)).identifier).toBe('lock-empty')
  })

  it('does not refuse a username that is the identifier, which changes no handle', async () => {
    const second = await createSite('locksame')
    await strapi
      .plugin('fediverse')
      .service('followers')
      .recordFollower(strapi, { actorId: 'https://remote.example/users/same' }, second)

    await edit(second, { fediverse: { username: 'locksame' } }).expect(200)
    await edit(second, { fediverse: { username: 'other' } }).expect(409)
  })

  it('gives a site no actor when its slug is the identifier of another, and refuses to set that identifier', async () => {
    // The default site's identifier is FEDIVERSE_ACTOR_IDENTIFIER.
    const clash = await createSite('devbog')
    expect((await readSite(clash)).identifier).toBeNull()

    const res = await edit(clash, { [SECTION]: { identifier: 'lock-b' } })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'identifier-taken' })
    expect((await readSite(clash)).identifier).toBeNull()
    await edit(clash, { [SECTION]: { identifier: 'clash-free' } }).expect(200)
    expect((await readSite(clash)).identifier).toBe('clash-free')
  })

  it('saves the default site while its section is still empty, as the Content Manager sends it', async () => {
    // A fresh database: the boot step has not written the identifier yet.
    const { documentId, identifier } = await readSite()
    expect(identifier).toBeNull()

    await edit(documentId, { [SECTION]: { identifier: null }, tagline: 'Saved' }).expect(200)

    // The variable stands in for the empty section: no other value is accepted.
    const other = await edit(documentId, { [SECTION]: { identifier: 'someone-else' } })
    expect(other.status).toBe(409)
    expect(other.body).toMatchObject({ code: 'identifier-locked' })
    expect((await readSite()).identifier).toBeNull()
  })

  it('refuses to create a site with the identifier of another', async () => {
    await expect(createSite('copycat', { [SECTION]: { identifier: 'devbog' } })).rejects.toThrow(
      /Another site already has this actor identifier/
    )
    await expect(createSite('copycat', { [SECTION]: { identifier: 'lock-b' } })).rejects.toThrow(
      /Another site already has this actor identifier/
    )

    const free = await createSite('copycat', { [SECTION]: { identifier: 'copycat-actor' } })
    expect((await readSite(free)).identifier).toBe('copycat-actor')
  })
})
