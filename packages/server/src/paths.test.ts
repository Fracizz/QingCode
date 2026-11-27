import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureRunDir,
  localPipeName,
  readDaemonJson,
  readOrCreateToken,
  readToken,
  removeDaemonJson,
  resolvePaths,
  writeDaemonJson,
} from './paths'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-paths-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolvePaths', () => {
  it('POSIX 默认目录与 unix socket', () => {
    const paths = resolvePaths(undefined, {
      env: { HOME: '/home/alice' },
      platform: 'linux',
      homedir: '/home/alice',
      username: 'alice',
    })
    expect(paths.stateDir).toBe('/home/alice/.qingcode-next/server')
    expect(paths.runDir).toBe('/home/alice/.qingcode-next/server/run')
    expect(paths.socketFile).toBe('/home/alice/.qingcode-next/server/run/daemon.sock')
    expect(paths.endpoint).toBe(paths.socketFile)
    expect(paths.customStateDir).toBe(false)
  })

  it('Windows 默认目录与命名管道', () => {
    const paths = resolvePaths(undefined, {
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', USERNAME: 'alice' },
      platform: 'win32',
      homedir: 'C:\\Users\\alice',
      username: 'alice',
    })
    expect(paths.stateDir).toBe('C:\\Users\\alice\\AppData\\Local\\qingcode-next\\server')
    expect(paths.endpoint).toBe('\\\\.\\pipe\\qingcode-next-alice')
    expect(paths.socketFile).toBeUndefined()
    expect(localPipeName('alice')).toBe(paths.endpoint)
  })

  it('自定义 state dir 在 Windows 上带哈希后缀，避免并行 daemon 抢同一管道', () => {
    const a = resolvePaths('D:\\state\\one', {
      env: { LOCALAPPDATA: 'C:\\Local', USERNAME: 'alice' },
      platform: 'win32',
      homedir: 'C:\\Users\\alice',
      username: 'alice',
    })
    const b = resolvePaths('D:\\state\\two', {
      env: { LOCALAPPDATA: 'C:\\Local', USERNAME: 'alice' },
      platform: 'win32',
      homedir: 'C:\\Users\\alice',
      username: 'alice',
    })
    expect(a.customStateDir).toBe(true)
    expect(a.endpoint.startsWith(`${localPipeName('alice')}-`)).toBe(true)
    expect(a.endpoint).not.toBe(b.endpoint)
  })

  it('显式传入默认目录仍视为默认', () => {
    const opts = {
      env: { HOME: '/home/alice' },
      platform: 'linux' as const,
      homedir: '/home/alice',
      username: 'alice',
    }
    const fallback = resolvePaths(undefined, opts)
    const explicit = resolvePaths('/home/alice/.qingcode-next/server', opts)
    expect(explicit.customStateDir).toBe(false)
    expect(explicit.endpoint).toBe(fallback.endpoint)
  })

  it('用户名里的非法字符被替换', () => {
    expect(localPipeName('DOMAIN\\bob')).toBe('\\\\.\\pipe\\qingcode-next-DOMAIN_bob')
  })
})

describe('run 目录文件', () => {
  it('token 幂等、格式正确，daemon.json 可读写', () => {
    const dir = tempDir()
    const paths = resolvePaths(dir)
    ensureRunDir(paths)
    expect(fs.existsSync(paths.runDir)).toBe(true)

    const token = readOrCreateToken(paths)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readOrCreateToken(paths)).toBe(token)
    expect(readToken(paths)).toBe(token)

    writeDaemonJson(paths, { pid: 42, version: '1.2.3', startedAt: 123 })
    expect(readDaemonJson(paths)).toEqual({ pid: 42, version: '1.2.3', startedAt: 123 })
    removeDaemonJson(paths)
    expect(readDaemonJson(paths)).toBeNull()
  })

  it('token 文件损坏时重建', () => {
    const dir = tempDir()
    const paths = resolvePaths(dir)
    ensureRunDir(paths)
    fs.writeFileSync(paths.tokenFile, 'bad', 'utf8')
    expect(readToken(paths)).toBeNull()
    expect(readOrCreateToken(paths)).toMatch(/^[0-9a-f]{64}$/)
  })
})
