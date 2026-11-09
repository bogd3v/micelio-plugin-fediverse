import { describe, it, expect } from 'vitest'
import { safeRemoteUrl } from '../server/src/utils/remote-url'

const MAX = 255

describe('safeRemoteUrl', () => {
  it('keeps an absolute https or http URL, normalised', () => {
    expect(safeRemoteUrl('https://cdn.example.test/avatar.png', MAX)).toBe(
      'https://cdn.example.test/avatar.png'
    )
    expect(safeRemoteUrl('http://cdn.example.test/a b.png', MAX)).toBe(
      'http://cdn.example.test/a%20b.png'
    )
    expect(safeRemoteUrl(new URL('HTTPS://CDN.example.test/x.png'), MAX)).toBe(
      'https://cdn.example.test/x.png'
    )
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://cdn.example.test/avatar.png',
  ])('drops the unsafe scheme of %s', (value) => {
    expect(safeRemoteUrl(value, MAX)).toBeNull()
    expect(safeRemoteUrl(new URL(value), MAX)).toBeNull()
  })

  it.each([
    'https://user:secret@cdn.example.test/avatar.png',
    'https://user@cdn.example.test/avatar.png',
    'https://:secret@cdn.example.test/avatar.png',
  ])('drops a URL with credentials, %s', (value) => {
    expect(safeRemoteUrl(value, MAX)).toBeNull()
  })

  it.each(['/avatar.png', 'avatar.png', '//cdn.example.test/avatar.png', '', ' '])(
    'drops the relative or empty value %j',
    (value) => {
      expect(safeRemoteUrl(value, MAX)).toBeNull()
    }
  )

  it('drops a URL longer than the limit and keeps one exactly at it', () => {
    const prefix = 'https://cdn.example.test/'
    const atLimit = prefix + 'a'.repeat(MAX - prefix.length)
    expect(safeRemoteUrl(atLimit, MAX)).toBe(atLimit)
    expect(safeRemoteUrl(atLimit + 'a', MAX)).toBeNull()
    expect(safeRemoteUrl(prefix + 'a'.repeat(3000), MAX)).toBeNull()
  })

  it.each([undefined, null, 42, {}])('gives null for %j', (value) => {
    expect(safeRemoteUrl(value, MAX)).toBeNull()
  })
})
