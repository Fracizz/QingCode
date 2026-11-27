import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkHostKey,
  fingerprintFromKey,
  hostKeyId,
  normalizeKnownHosts,
  previousHostKey,
  readKnownHosts,
  setHostKey,
  writeKnownHosts,
} from './hostKeys'

const dirs: string[] = []
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'qn-hostkeys-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('hostKeys', () => {
  it('指纹是原始 key 的 SHA256 base64（无填充），与 OpenSSH 显示一致', () => {
    const key = Buffer.from('ssh-ed25519 AAAA-test')
    const expected = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
    expect(fingerprintFromKey(key)).toBe(expected)
    expect(fingerprintFromKey(key)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(hostKeyId('192.168.10.93', 22)).toBe('192.168.10.93:22')
  })

  it('checkHostKey 区分 new / match / changed', () => {
    const empty = normalizeKnownHosts(null)
    expect(checkHostKey(empty, 'h', 22, 'SHA256:aaa')).toBe('new')
    const stored = setHostKey(empty, 'h', 22, 'SHA256:aaa')
    expect(checkHostKey(stored, 'h', 22, 'SHA256:aaa')).toBe('match')
    expect(checkHostKey(stored, 'h', 22, 'SHA256:bbb')).toBe('changed')
    expect(previousHostKey(stored, 'h', 22)).toBe('SHA256:aaa')
    expect(setHostKey(stored, 'h', 22, 'SHA256:bbb')['h:22']).toBe('SHA256:bbb')
    // 端口不同视为不同主机。
    expect(checkHostKey(stored, 'h', 2222, 'SHA256:aaa')).toBe('new')
  })

  it('损坏条目被丢弃，损坏文件按空库处理', () => {
    expect(normalizeKnownHosts({ a: 'SHA256:x', b: 3, c: null, d: '' })).toEqual({ a: 'SHA256:x' })
    expect(normalizeKnownHosts([])).toEqual({})
  })

  it('known_hosts.json 读写', async () => {
    const dir = await tempDir()
    expect(await readKnownHosts(dir)).toEqual({})
    const store = setHostKey({}, 'host', 22, 'SHA256:legacy')
    await writeKnownHosts(dir, store)
    expect(await readKnownHosts(dir)).toEqual(store)
    await writeKnownHosts(dir, setHostKey(store, 'other', 2200, 'SHA256:new'))
    expect(await readKnownHosts(dir)).toEqual({
      'host:22': 'SHA256:legacy',
      'other:2200': 'SHA256:new',
    })
  })
})
