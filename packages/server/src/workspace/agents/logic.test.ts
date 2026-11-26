import { describe, expect, it } from 'vitest'
import {
  agentExecutableNames,
  buildVersionCommand,
  classifyVersionRun,
  isBareName,
  isProbeAgent,
  parseProbeParams,
  parseProbeVersion,
  probeCandidates,
  type ProbeEnv,
} from './logic'

const winEnv: ProbeEnv = {
  platform: 'win32',
  pathValue: 'C:\\bin;D:\\tools',
  home: 'C:\\Users\\me',
  delimiter: ';',
  localAppData: 'C:\\Users\\me\\AppData\\Local',
}
const posixEnv: ProbeEnv = {
  platform: 'linux',
  pathValue: '/usr/bin:/opt/bin',
  home: '/home/me',
  delimiter: ':',
}

describe('parseProbeParams', () => {
  it('接受三个 agent 与可选路径，缺省路径按自动解析处理', () => {
    expect(parseProbeParams({ agent: 'codex' })).toEqual({ agent: 'codex' })
    expect(parseProbeParams({ agent: 'claude', path: '  /opt/claude.exe  ' })).toEqual({
      agent: 'claude',
      path: '/opt/claude.exe',
    })
    expect(parseProbeParams({ agent: 'pi', path: '   ' })).toEqual({ agent: 'pi' })
    expect(parseProbeParams({ agent: 'pi', path: null })).toEqual({ agent: 'pi' })
  })

  it('拒绝未知 agent、非法路径与异常长路径', () => {
    expect(parseProbeParams({ agent: 'other' })).toBeNull()
    expect(parseProbeParams({})).toBeNull()
    expect(parseProbeParams({ agent: 'codex', path: 42 })).toBeNull()
    expect(parseProbeParams({ agent: 'codex', path: 'a\0b' })).toBeNull()
    expect(parseProbeParams({ agent: 'codex', path: 'x'.repeat(5000) })).toBeNull()
    expect(isProbeAgent('codex')).toBe(true)
    expect(isProbeAgent('claude')).toBe(true)
    expect(isProbeAgent('pi')).toBe(true)
    expect(isProbeAgent('other')).toBe(false)
  })
})

describe('probeCandidates', () => {
  it('显式路径优先，且不再枚举 PATH', () => {
    expect(probeCandidates('codex', 'D:\\my\\codex.exe', winEnv)).toEqual(['D:\\my\\codex.exe'])
  })

  it('Windows 下 Claude 只解析 .exe（不解析 .cmd）', () => {
    expect(agentExecutableNames('claude', 'win32')).toEqual(['claude.exe', 'claude'])
    expect(agentExecutableNames('codex', 'win32')).toContain('codex.cmd')
    expect(agentExecutableNames('pi', 'win32')).toContain('pi.ps1')
    const candidates = probeCandidates('claude', undefined, winEnv)
    expect(candidates).toContain('C:\\bin\\claude.exe')
    expect(candidates.some((item) => item.endsWith('.cmd'))).toBe(false)
    expect(candidates.at(-1)).toBe('claude')
  })

  it('POSIX 依次覆盖 PATH、常见安装目录与裸名字，且不重复', () => {
    const candidates = probeCandidates('codex', undefined, posixEnv)
    expect(candidates.slice(0, 2)).toEqual(['/usr/bin/codex', '/opt/bin/codex'])
    expect(candidates).toContain('/home/me/.local/bin/codex')
    expect(candidates).toContain('/usr/local/bin/codex')
    expect(candidates.at(-1)).toBe('codex')
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('parseProbeVersion', () => {
  it('从常见版本输出里取版本号，无版本号时返回 undefined', () => {
    expect(parseProbeVersion('codex-cli 0.172.0\n')).toBe('0.172.0')
    expect(parseProbeVersion('2.1.331 (Claude Code)')).toBe('2.1.331')
    expect(parseProbeVersion('pi 1.6.1')).toBe('1.6.1')
    expect(parseProbeVersion('v0.0.1-alpha.2')).toBe('0.0.1-alpha.2')
    expect(parseProbeVersion('unknown')).toBeUndefined()
  })
})

describe('buildVersionCommand', () => {
  it('普通可执行文件只带 --version，不经 shell', () => {
    expect(buildVersionCommand('/usr/bin/codex', 'linux')).toEqual({
      command: '/usr/bin/codex',
      args: ['--version'],
      verbatim: false,
    })
    expect(buildVersionCommand('C:\\bin\\claude.exe', 'win32')).toEqual({
      command: 'C:\\bin\\claude.exe',
      args: ['--version'],
      verbatim: false,
    })
  })

  it('Windows .cmd 交给 cmd.exe 且去掉引号，防止路径注入', () => {
    expect(buildVersionCommand('C:\\bin\\co"dex.cmd', 'win32', 'C:\\Windows\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\bin\\codex.cmd" --version'],
      verbatim: true,
    })
  })
})

describe('classifyVersionRun', () => {
  const base = { status: 0, stdout: '', stderr: '', timedOut: false }

  it('映射错误码与超时，错误文案不含原始输出', () => {
    expect(classifyVersionRun({ ...base, timedOut: true })).toEqual({ ok: false, error: '执行 --version 超时' })
    expect(classifyVersionRun({ ...base, errorCode: 'ENOENT' })).toEqual({ ok: false, error: '未找到可执行文件' })
    expect(classifyVersionRun({ ...base, errorCode: 'EACCES' })).toEqual({ ok: false, error: '没有执行权限' })
    expect(classifyVersionRun({ ...base, errorCode: 'EINVAL' })).toEqual({ ok: false, error: '无法运行 --version' })
  })

  it('退出码非零但有版本仍算成功；无版本且非零算失败', () => {
    expect(classifyVersionRun({ ...base, status: 1, stdout: 'claude 2.1.331' })).toEqual({
      ok: true,
      version: '2.1.331',
    })
    expect(classifyVersionRun({ ...base, status: 1 })).toEqual({ ok: false, error: '可执行文件返回非零状态' })
    expect(classifyVersionRun(base)).toEqual({ ok: true })
    expect(classifyVersionRun({ ...base, stderr: 'secret sk-abcdefghijk' })).toEqual({ ok: true })
  })
})

describe('isBareName', () => {
  it('区分裸名字与带路径的文件', () => {
    expect(isBareName('codex.exe')).toBe(true)
    expect(isBareName('C:\\bin\\codex.exe')).toBe(false)
    expect(isBareName('/usr/bin/codex')).toBe(false)
  })
})
