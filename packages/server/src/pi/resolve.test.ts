import { describe, expect, it } from 'vitest'
import { AgentHostError } from '../codexHost'
import {
  piCandidates,
  readPiVersion,
  resolvePiExecutable,
  wrapPiCommand,
} from './resolve'

describe('pi 可执行文件解析', () => {
  it('Windows 按 exe/cmd/ps1/pi 顺序找，POSIX 只找 pi', () => {
    const win = piCandidates(undefined, 'win32')
    expect(win.some((candidate) => candidate.endsWith('pi.exe'))).toBe(true)
    expect(win.some((candidate) => candidate.endsWith('pi.cmd'))).toBe(true)
    expect(win.some((candidate) => candidate.endsWith('pi.ps1'))).toBe(true)
    expect(piCandidates(undefined, 'linux').every((candidate) => candidate.endsWith('pi'))).toBe(true)
    expect(piCandidates('D:/tools/pi.exe', 'win32')).toEqual(['D:/tools/pi.exe'])
  })

  it('.cmd 走 shell 并转义引号，.ps1 经 powershell -File，其余不经 shell', () => {
    expect(wrapPiCommand('C:/a b/pi.cmd', 'win32')).toEqual({
      command: '"C:/a b/pi.cmd"',
      args: [],
      shell: true,
    })
    expect(wrapPiCommand('C:/a/pi".cmd', 'win32').command).toBe('"C:/a/pi.cmd"')
    const ps1 = wrapPiCommand('C:/a/pi.ps1', 'win32')
    expect(ps1.command).toBe('powershell.exe')
    expect(ps1.args).toContain('-File')
    expect(ps1.shell).toBe(false)
    expect(wrapPiCommand('/usr/local/bin/pi', 'linux')).toEqual({
      command: '/usr/local/bin/pi',
      args: [],
      shell: false,
    })
  })

  it('只解析已安装的文件；找不到时报 agent_unavailable 且不自动安装', () => {
    const resolved = resolvePiExecutable(undefined, {
      platform: 'linux',
      exists: (file) => file === '/usr/local/bin/pi',
      versionOf: (file) => (file === '/usr/local/bin/pi' ? '1.6.1' : 'unknown'),
    })
    expect(resolved).toMatchObject({ path: '/usr/local/bin/pi', version: '1.6.1', shell: false })

    expect(() =>
      resolvePiExecutable(undefined, { platform: 'linux', exists: () => false }),
    ).toThrowError(AgentHostError)
    try {
      resolvePiExecutable(undefined, { platform: 'linux', exists: () => false })
    } catch (err) {
      expect((err as AgentHostError).code).toBe('agent_unavailable')
      expect((err as Error).message).toContain('安装')
    }
  })

  it('测试钩子：数组形式按 [可执行文件, ...参数] 原样启动且不做版本探测', () => {
    const resolved = resolvePiExecutable('["node","fake-pi.mjs"]')
    expect(resolved).toEqual({
      command: 'node',
      args: ['fake-pi.mjs'],
      shell: false,
      path: 'node',
      version: 'test',
    })
    expect(() => resolvePiExecutable('["node",1]')).toThrowError(/数组/)
  })

  it('--version 探测只解析版本号，不打印凭据', () => {
    expect(typeof readPiVersion('/definitely/missing/pi')).toBe('string')
  })
})
