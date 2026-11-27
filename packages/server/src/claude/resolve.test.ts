import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentHostError } from '../codexHost'
import { claudeCandidates, resolveClaudeExecutable } from './resolve'

describe('claude 可执行文件解析', () => {
  it('显式路径优先，且不会再去搜 PATH', () => {
    expect(claudeCandidates('C:/tools/claude.exe')).toEqual(['C:/tools/claude.exe'])
  })

  it('候选包含 PATH、~/.local/bin 与常见全局目录', () => {
    const candidates = claudeCandidates()
    expect(candidates.length).toBeGreaterThan(2)
    expect(candidates.some((file) => file.includes(path.join('.local', 'bin')))).toBe(true)
    // Windows 补 %APPDATA%\npm / WindowsApps，POSIX 补 ~/.npm-global/bin。
    expect(candidates.some((file) => /npm-global|npm|WindowsApps/i.test(file))).toBe(true)
    // Windows 不用 .cmd；SDK 需要可直接 spawn 的 .exe。
    expect(candidates.some((file) => file.endsWith('.cmd'))).toBe(false)
  })

  it('找到文件时返回版本，未找到时报 agent_unavailable', () => {
    const found = resolveClaudeExecutable(undefined, {
      exists: (file) => file.endsWith('claude.exe') || file.endsWith('claude'),
      versionOf: () => '2.1.331',
    })
    expect(found.version).toBe('2.1.331')
    expect(found.path.length).toBeGreaterThan(0)

    let error: unknown
    try {
      resolveClaudeExecutable('C:/missing/claude.exe', {
        exists: () => false,
        versionOf: () => '2.1.331',
      })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(AgentHostError)
    expect((error as AgentHostError).code).toBe('agent_unavailable')
    expect((error as AgentHostError).message).toContain('C:/missing/claude.exe')
  })

  it('版本探测失败时返回 unknown，不影响可执行文件解析', () => {
    const found = resolveClaudeExecutable('fake', {
      exists: () => true,
      versionOf: () => 'unknown',
    })
    expect(found).toEqual({ path: 'fake', version: 'unknown' })
  })
})
