import { describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import { findWorkspaceHandler } from '../index'
import { defaultProbeDeps, probeAgent, type ProbeDeps } from './probe'
import type { ProbeEnv, VersionRun } from './logic'

const env: ProbeEnv = {
  platform: 'linux',
  pathValue: '/opt/bin',
  home: '/home/me',
  delimiter: ':',
}

const ok = (stdout: string): VersionRun => ({
  status: 0,
  stdout,
  stderr: '',
  timedOut: false,
})
const missing: VersionRun = {
  status: null,
  stdout: '',
  stderr: '',
  errorCode: 'ENOENT',
  timedOut: false,
}

function deps(overrides: {
  exists?: (file: string) => boolean
  run?: (file: string) => VersionRun
} = {}): ProbeDeps {
  return {
    exists: overrides.exists ?? (() => false),
    run: overrides.run ?? (() => missing),
    env,
  }
}

describe('probeAgent', () => {
  it('找到第一个可执行文件并返回版本与解析出的路径', () => {
    const tried: string[] = []
    const result = probeAgent(
      { agent: 'codex' },
      deps({
        exists: (file) => file === '/opt/bin/codex',
        run: (file) => {
          tried.push(file)
          return ok('codex-cli 0.172.0')
        },
      }),
    )
    expect(result).toEqual({ found: true, path: '/opt/bin/codex', version: '0.172.0' })
    expect(tried).toEqual(['/opt/bin/codex'])
  })

  it('裸名字兜底也能命中（spawn 按 PATH 解析）', () => {
    const result = probeAgent(
      { agent: 'claude' },
      deps({ run: (file) => (file === 'claude' ? ok('2.1.331 (Claude Code)') : missing) }),
    )
    expect(result).toEqual({ found: true, path: 'claude', version: '2.1.331' })
  })

  it('全部候选失败时返回 found:false 与最后一个错误，不泄露子进程输出', () => {
    const result = probeAgent(
      { agent: 'pi', path: '/opt/missing/pi' },
      deps({
        exists: () => true,
        run: () => ({ status: 1, stdout: 'sk-secret-value', stderr: '', timedOut: false }),
      }),
    )
    expect(result).toEqual({
      found: false,
      path: '/opt/missing/pi',
      error: '可执行文件返回非零状态',
    })
    expect(JSON.stringify(result)).not.toContain('sk-secret-value')
  })

  it('参数无效抛 WorkspaceError(params)', () => {
    expect(() => probeAgent({ agent: 'unknown' }, deps())).toThrowError(WorkspaceError)
    try {
      probeAgent({ agent: 'codex', path: 123 }, deps())
      expect.unreachable('应当抛错')
    } catch (err) {
      expect((err as WorkspaceError).code).toBe('params')
    }
  })

  it('默认依赖能用真实的 node --version 完成一次探测（不启动 Agent 会话）', () => {
    const result = probeAgent({ agent: 'codex', path: process.execPath }, defaultProbeDeps())
    expect(result.found).toBe(true)
    expect(result.path).toBe(process.execPath)
    expect(result.version).toMatch(/^\d+\.\d+/)
  })
})

describe('workspace 登记', () => {
  it('findWorkspaceHandler 能找到 agent.probe', () => {
    expect(findWorkspaceHandler('agent.probe')).toBeTypeOf('function')
  })
})
