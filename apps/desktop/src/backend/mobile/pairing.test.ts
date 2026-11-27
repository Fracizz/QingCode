import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PAIR_FAILURE_LIMIT,
  cleanDeviceName,
  constantTimeEqual,
  DeviceStore,
  deviceFilePath,
  hashToken,
  isPairLocked,
  makePairedDevice,
  newPairingToken,
  normalizePairFailure,
  parseDeviceRecords,
  publicDevice,
  recordPairFailure,
} from './pairing'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qn-mobile-pairing-'))
  tempDirs.push(dir)
  return dir
}

describe('配对纯逻辑', () => {
  it('生成 32 字节令牌且只存 SHA-256 摘要', () => {
    const token = newPairingToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).not.toBe(token)
    const created = makePairedDevice({
      token,
      id: 'd1',
      name: '  我的手机  ',
      ip: '127.0.0.1',
      now: 1000,
    })
    expect(created.device.tokenHash).toBe(hashToken(token))
    expect(created.device.name).toBe('我的手机')
    expect(publicDevice(created.device)).not.toHaveProperty('tokenHash')
    expect(cleanDeviceName('a\u0000b')).toBe('ab')
    expect(cleanDeviceName(42)).toBe('手机')
  })

  it('密码比较使用常量时间摘要且区分大小写', () => {
    expect(constantTimeEqual('Pair.Code!', 'Pair.Code!')).toBe(true)
    expect(constantTimeEqual('Pair.Code!', 'pair.Code!')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('short', 'a much longer string')).toBe(false)
  })

  it('连续 5 次失败即锁 60 秒，锁定与过期后都重置', () => {
    let state = undefined as ReturnType<typeof recordPairFailure> | undefined
    for (let i = 0; i < PAIR_FAILURE_LIMIT - 1; i += 1) {
      state = recordPairFailure(state, 1000)
      expect(isPairLocked(state, 1000)).toBe(false)
    }
    state = recordPairFailure(state, 1000)
    expect(state.count).toBe(PAIR_FAILURE_LIMIT)
    expect(isPairLocked(state, 1000)).toBe(true)
    expect(recordPairFailure(state, 1000)).toEqual(state)
    expect(isPairLocked(state, 1000 + 60_000)).toBe(false)
    expect(normalizePairFailure(state, 1000 + 60_001)).toBeUndefined()
    const stale = recordPairFailure(undefined, 0)
    expect(normalizePairFailure(stale, 60_000)).toBeUndefined()
  })

  it('解析设备文件时忽略明文字段与损坏记录', () => {
    const created = makePairedDevice({
      token: 'a'.repeat(64),
      id: 'd1',
      name: '手机',
      ip: '1.2.3.4',
      now: 10,
    }).device
    expect(parseDeviceRecords({ devices: [created, { ...created, tokenHash: 'bad' }, { token: 'leak' }] }))
      .toEqual([created])
    expect(parseDeviceRecords('bad')).toEqual([])
  })
})

describe('DeviceStore', () => {
  it('持久化摘要、更新在线状态、撤销设备', async () => {
    const dir = await tempDir()
    const file = deviceFilePath(dir)
    const store = new DeviceStore(file, () => 1000)
    const token = 'b'.repeat(64)
    const { device } = await store.add({
      token,
      name: '手机 A',
      ip: '127.0.0.1',
      now: 1000,
    })
    expect(await store.list()).toEqual([publicDevice({
      id: device.id,
      name: '手机 A',
      tokenHash: hashToken(token),
      pairedAt: 1000,
      lastSeenAt: 1000,
      lastIp: '127.0.0.1',
    })])

    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(token)
    expect(raw).toContain(hashToken(token))
    expect(raw).not.toContain('"token"')

    expect(await store.authenticate(token, '10.0.0.1', 2000)).toMatchObject({
      id: device.id,
      lastSeenAt: 2000,
      lastIp: '10.0.0.1',
    })
    expect(await store.authenticate('c'.repeat(64), '10.0.0.1', 3000)).toBeNull()
    expect(await store.touch(device.id, '10.0.0.2', 4000)).toBe(true)
    expect(await store.revoke(device.id)).toBe(true)
    expect(await store.revoke(device.id)).toBe(false)
    expect(await store.authenticate(token, '10.0.0.1', 5000)).toBeNull()
    expect(await store.touch(device.id, '10.0.0.1', 5000)).toBe(false)

    await store.add({ name: '手机 B', ip: '127.0.0.1', now: 6000 })
    await store.revokeAll()
    expect(await store.list()).toEqual([])
  })
})
