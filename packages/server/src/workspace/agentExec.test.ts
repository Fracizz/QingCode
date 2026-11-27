import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCandidates, resolveClaudeExecutable } from '../claude/resolve'
import {
  codexCandidates,
  quoteCmdToken,
  resolveCodexCommand,
  wrapCommand,
  type CodexResolveEnv,
} from '../codexHost'

const winEnv: CodexResolveEnv = {
  platform: 'win32',
  pathValue: 'C:\\bin;D:\\tools',
  delimiter: ';',
  home: 'C:\\Users\\tester',
  appData: 'C:\\Users\\tester\\AppData\\Roaming',
  localAppData: 'C:\\Users\\tester\\AppData\\Local',
  comspec: 'cmd.exe',
}

const posixEnv: CodexResolveEnv = {
  platform: 'linux',
  pathValue: '/usr/bin:/home/tester/bin',
  delimiter: ':',
  home: '/home/tester',
}

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-agent-exec-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('codex / claude 可执行文件候选（Windows PATH 之外的安装位置）', () => {
  it('codex 覆盖 npm 全局 codex.cmd、WindowsApps codex.exe 与 PATH', () => {
    const candidates = codexCandidates(undefined, winEnv)
    expect(candidates).toContain('C:\\bin\\codex.cmd')
    expect(candidates).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd')
    expect(
      candidates,
    ).toContain('C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe')
    expect(new Set(candidates.map((item) => item.toLowerCase())).size).toBe(candidates.length)
  })

  it('claude 覆盖 ~/.local/bin/claude.exe 与常见安装目录，不列 .cmd', () => {
    const candidates = claudeCandidates(undefined, {
      platform: 'win32',
      pathValue: winEnv.pathValue,
      delimiter: ';',
      home: winEnv.home,
      appData: winEnv.appData,
      localAppData: winEnv.localAppData,
    })
    expect(candidates).toContain('C:\\Users\\tester\\.local\\bin\\claude.exe')
    expect(candidates).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.exe')
    expect(candidates.some((file) => file.endsWith('.cmd'))).toBe(false)
    expect(
      resolveClaudeExecutable(undefined, {
        env: {
          platform: 'win32',
          pathValue: winEnv.pathValue,
          delimiter: ';',
          home: winEnv.home,
        },
        exists: (file) => file.endsWith('.local\\bin\\claude.exe'),
        versionOf: () => '2.1.331',
      }),
    ).toEqual({
      path: 'C:\\Users\\tester\\.local\\bin\\claude.exe',
      version: '2.1.331',
    })
  })

  it('显式路径优先；POSIX 仍按 PATH → 常见目录解析', () => {
    expect(codexCandidates('C:/tools/codex.cmd', winEnv)).toEqual(['C:/tools/codex.cmd'])
    expect(
      claudeCandidates('/opt/claude', {
        platform: 'linux',
        pathValue: posixEnv.pathValue,
        delimiter: ':',
        home: posixEnv.home,
      }),
    ).toEqual(['/opt/claude'])
    const candidates = codexCandidates(undefined, posixEnv)
    expect(candidates).toContain('/usr/bin/codex')
    expect(candidates).toContain('/home/tester/.local/bin/codex')
    expect(candidates).toContain('/usr/local/bin/codex')
  })
})

describe('.cmd/.bat 安全启动', () => {
  it('不用 shell:true，经 cmd.exe /s /c + 逐 token 引号 + verbatim 传参', () => {
    const spec = wrapCommand('C:\\Program Files\\npm\\codex.cmd', ['app-server'], winEnv)
    expect(spec.shell).toBe(false)
    expect(spec.windowsVerbatimArguments).toBe(true)
    expect(spec.command).toBe('cmd.exe')
    expect(spec.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    expect(spec.args[4]).toBe('""C:\\Program Files\\npm\\codex.cmd" "app-server""')
  })

  it('可执行文件不是脚本时不经 cmd.exe', () => {
    expect(wrapCommand('C:\\bin\\codex.exe', ['app-server'], winEnv)).toEqual({
      command: 'C:\\bin\\codex.exe',
      args: ['app-server'],
      shell: false,
    })
    expect(wrapCommand('/usr/bin/codex', ['app-server'], posixEnv).shell).toBe(false)
  })

  it('拒绝引号、% / ! 与换行，避免 cmd 展开或注入', () => {
    expect(quoteCmdToken('app-server')).toBe('"app-server"')
    for (const value of ['C:\\a"b.cmd', 'C:\\a%PATH%b.cmd', 'C:\\a!b.cmd', 'a\nb', 'a\0b']) {
      expect(() => quoteCmdToken(value)).toThrow(/不允许的字符/)
    }
  })

  it('显式 .cmd 路径与 JSON 数组测试钩子都能解析', () => {
    const script = 'C:\\tools\\codex.cmd'
    const spec = resolveCodexCommand(script, winEnv, (file) => file === script)
    expect(spec.windowsVerbatimArguments).toBe(true)
    expect(spec.args[4]).toContain(script)
    const arr = resolveCodexCommand(
      JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
      winEnv,
      () => false,
    )
    expect(arr).toEqual({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      shell: false,
    })
  })

  it.skipIf(process.platform !== 'win32')('本机 Windows：含空格与 & 的 .cmd 能启动且不注入命令', () => {
    const dir = tempDir()
    const file = path.join(dir, 'codex & echo.cmd')
    fs.writeFileSync(file, '@echo off\r\necho GOT:%*\r\n')
    const spec = resolveCodexCommand(file, winEnv, (candidate) => candidate === file)
    const result = spawnSync(spec.command, spec.args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('GOT:"app-server"')
    expect(result.stdout).not.toContain('INJECTED')

    // 参数里的 cmd 元字符被引号包住，不会额外执行命令。
    const withArg = wrapCommand(file, ['app-server & echo INJECTED'], winEnv)
    const injected = spawnSync(withArg.command, withArg.args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    expect(injected.stdout).not.toContain('INJECTED\r\n')
    expect(injected.stdout).toContain('app-server')
  })

  it.skipIf(process.platform !== 'win32')('本机 Windows：.cmd 经 cmd.exe 仍能收发 stdio', () => {
    const dir = tempDir()
    const file = path.join(dir, 'codex.cmd')
    fs.writeFileSync(file, '@echo off\r\nset /p LINE=\r\necho GOT:%LINE%\r\n')
    const spec = resolveCodexCommand(file, winEnv, (candidate) => candidate === file)
    const result = spawnSync(spec.command, spec.args, {
      input: 'ping\n',
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('GOT:ping')
  })
})
