import { describe, expect, it } from 'vitest'
import { classifyAddress, isAllowedPeer, normalizeRemoteAddress } from './netPolicy'

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.9', 'private'],
    ['100.64.1.20', 'cgnat'],
    ['100.128.0.1', 'public'],
    ['169.254.1.1', 'link-local'],
    ['fd7a:115c:a1e0::1', 'private'],
    ['fe80::1%eth0', 'link-local'],
    ['8.8.8.8', 'public'],
    ['2001:4860::8888', 'public'],
    ['not-an-ip', 'invalid'],
  ])('%s → %s', (ip, kind) => {
    expect(classifyAddress(ip)).toBe(kind)
  })

  it('normalizes mapped and zoned addresses', () => {
    expect(normalizeRemoteAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1')
    expect(normalizeRemoteAddress('FE80::1%3')).toBe('fe80::1')
  })
})

describe('isAllowedPeer', () => {
  it('refuses public unless allowed', () => {
    expect(isAllowedPeer('8.8.8.8', false)).toBe(false)
    expect(isAllowedPeer('8.8.8.8', true)).toBe(true)
    expect(isAllowedPeer('192.168.0.2', false)).toBe(true)
  })

  it('refuses missing or invalid addresses', () => {
    expect(isAllowedPeer(undefined, true)).toBe(false)
    expect(isAllowedPeer('bogus', true)).toBe(false)
  })
})
