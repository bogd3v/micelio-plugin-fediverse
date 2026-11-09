import { describe, it, expect } from 'vitest'
import { describeDeliveryError } from '../server/src/utils/delivery-error'

describe('describeDeliveryError (federated article lastError)', () => {
  it('cuts query strings and fragments from every URL', () => {
    const text = describeDeliveryError(
      new Error('POST https://remote.example/inbox?token=secret#frag failed with 500')
    )
    expect(text).toBe('POST https://remote.example/inbox failed with 500')
  })

  it.each([
    ['an IPv4 literal', 'connect ECONNREFUSED 127.0.0.1:1', '127.0.0.1'],
    ['an IPv4 host in a URL', 'POST http://10.1.2.3:8080/inbox failed', '10.1.2.3'],
    ['a bracketed IPv6 host', 'POST http://[2001:db8::1]:8080/inbox failed', '2001:db8::1'],
    ['a bare IPv6 literal', 'connect ECONNREFUSED ::1:3000', '::1'],
    ['a mapped IPv6 literal', 'connect ::ffff:192.168.0.9 timed out', '192.168.0.9'],
  ])('replaces %s', (_label, message, address) => {
    const text = describeDeliveryError(new Error(message)) ?? ''
    expect(text).not.toContain(address)
    expect(text).toContain('[ip]')
  })

  it('replaces email addresses', () => {
    expect(describeDeliveryError(new Error('rejected for reader@example.com'))).toBe(
      'rejected for [email]'
    )
  })

  it('leaves times and ordinary words alone', () => {
    expect(describeDeliveryError(new Error('failed at 12:30:45 added: deaf'))).toBe(
      'failed at 12:30:45 added: deaf'
    )
  })

  it('reads the first sub-errors of an error with causes', () => {
    const error = Object.assign(new Error('Failed to send'), {
      errors: [new Error('one https://a.example/inbox?x=1'), new Error('two 127.0.0.1')],
    })
    const text = describeDeliveryError(error) ?? ''
    expect(text).toContain('Failed to send')
    expect(text).toContain('https://a.example/inbox')
    expect(text).not.toMatch(/\?x=1|127\.0\.0\.1/)
  })

  it('cleans control characters and keeps at most 500 characters', () => {
    const text = describeDeliveryError(new Error(`a\nb${'x'.repeat(900)}`)) ?? ''
    expect(text.startsWith('a b')).toBe(true)
    expect(Array.from(text)).toHaveLength(500)
  })

  it('answers null when there is nothing to say', () => {
    expect(describeDeliveryError(new Error(''))).toBeNull()
    expect(describeDeliveryError(undefined)).toBeNull()
  })
})
