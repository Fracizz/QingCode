import { describe, expect, it } from 'vitest'
import { WorkspaceError } from '../workspace/registry'
import type { Capabilities } from './logic'
import { createDefaultResolver, pythonBackend, scriptBackend } from './posix'

const ok = { ok: true, version: '1', detail: '' }
const no = { ok: false, version: '', detail: '缺失' }

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (err) {
    return err instanceof WorkspaceError ? err.code : 'other'
  }
  return undefined
}

describe('默认后端解析器', () => {
  it.skipIf(process.platform !== 'win32')('Windows 默认选择 ConPTY，拒绝 POSIX 后端', async () => {
    const resolve = createDefaultResolver(async () => ({ posix: false, python3: no, script: no }))
    expect(await resolve('auto')).toMatchObject({ name: 'conpty', supportsResize: true })
    expect(await codeOf(resolve('python'))).toBe('pty_unavailable')
  })

  it.skipIf(process.platform === 'win32')('POSIX：按探测结果选 python3 / script，都没有时 pty_unavailable', async () => {
    const make = (caps: Capabilities) => createDefaultResolver(async () => caps)
    expect(await make({ posix: true, python3: ok, script: ok })('auto')).toBe(pythonBackend)
    expect(await make({ posix: true, python3: no, script: ok })('auto')).toBe(scriptBackend)
    expect(await codeOf(make({ posix: true, python3: no, script: no })('auto'))).toBe('pty_unavailable')
    expect(await codeOf(make({ posix: true, python3: no, script: ok })('python'))).toBe('pty_unavailable')
  })
})
