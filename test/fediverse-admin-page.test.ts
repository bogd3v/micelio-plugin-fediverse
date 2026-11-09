import { describe, it, expect } from 'vitest'
import {
  checkLabelId,
  checkValue,
  failureTitle,
  fixMessageId,
  followerLabel,
  followerStatus,
  type Check,
  type Failure,
  type Follower,
} from '../admin/src/page-state'
import en from '../admin/src/translations/en.json'
import es from '../admin/src/translations/es.json'

const check = (over: Partial<Check>): Check => ({
  id: 'public-url',
  ok: true,
  code: null,
  value: null,
  ...over,
})
const follower = (over: Partial<Follower> = {}): Follower => ({
  documentId: 'f1',
  handle: '@reader@remote.example.test',
  name: 'Reader',
  since: '2026-01-01T00:00:00Z',
  blocked: false,
  unreachableSince: null,
  ...over,
})

describe('Fediverse admin page: what it says', () => {
  it('shows a fix text only for a failing check, from its code', () => {
    expect(fixMessageId(check({ ok: true }))).toBeNull()
    expect(fixMessageId(check({ ok: null, value: 3 }))).toBeNull()
    expect(fixMessageId(check({ ok: false, code: 'url-missing' }))).toBe(
      'fediverse.page.fix.url-missing'
    )
  })

  it('has a name for every diagnostic and a description for each backend, in both languages', () => {
    for (const id of [
      'public-url',
      'actor-key',
      'webfinger',
      'backend',
      'followers',
      'inbox-refusals',
    ]) {
      const label = checkLabelId(check({ id }))
      expect(Object.keys(en)).toContain(label)
      expect(Object.keys(es)).toContain(label)
    }
    for (const backend of ['postgres', 'memory']) {
      const shown = checkValue(check({ id: 'backend', ok: null, value: backend }))
      expect(shown && 'messageId' in shown ? shown.messageId : '').toBe(
        `fediverse.page.backend.${backend}`
      )
      expect(Object.keys(en)).toContain(`fediverse.page.backend.${backend}`)
      expect(Object.keys(es)).toContain(`fediverse.page.backend.${backend}`)
    }
    expect(checkValue(check({ id: 'followers', ok: null, value: 12 }))).toEqual({ text: '12' })
    expect(checkValue(check({ value: null }))).toBeNull()
  })

  it('puts blocked before unreachable before active', () => {
    expect(followerStatus(follower())).toBe('active')
    expect(followerStatus(follower({ unreachableSince: '2026-01-02T00:00:00Z' }))).toBe(
      'unreachable'
    )
    expect(
      followerStatus(follower({ blocked: true, unreachableSince: '2026-01-02T00:00:00Z' }))
    ).toBe('blocked')
    for (const status of ['active', 'blocked', 'unreachable']) {
      expect(Object.keys(en)).toContain(`fediverse.page.followers.${status}`)
      expect(Object.keys(es)).toContain(`fediverse.page.followers.${status}`)
    }
  })

  it('names a follower by handle, else name, else a dash', () => {
    expect(followerLabel(follower())).toBe('@reader@remote.example.test')
    expect(followerLabel(follower({ handle: null }))).toBe('Reader')
    expect(followerLabel(follower({ handle: null, name: null }))).toBe('—')
  })

  it('shows the title of a failed article, or says it was removed', () => {
    const row = (title: string | null): Failure => ({
      articleDocumentId: 'a1',
      title,
      lastActivityType: 'Create',
      lastActivityAt: null,
      attempts: 3,
      lastError: null,
    })
    expect(failureTitle(row('Hello'))).toEqual({ text: 'Hello' })
    expect(failureTitle(row(null))).toEqual({ messageId: 'fediverse.page.failures.deleted' })
  })
})
