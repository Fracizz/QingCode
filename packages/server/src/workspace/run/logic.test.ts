import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSpawnPlan,
  displayCommand,
  findInPath,
  mergeEnv,
  parseStartParams,
  platformToOs,
  resolveTaskForOs,
  resolveWorkdir,
  scriptKind,
  shellQuote,
  type CommandTools,
} from './logic'

const ABS = process.platform === 'win32' ? 'D:\\proj' : '/proj'

const tools = (found: Record<string, string> = {}): CommandTools => ({
  which: (name) => found[name] ?? null,
  comspec: 'C:\\Windows\\system32\\cmd.exe',
})

describe('parseStartParams', () => {
  it('校验并规整参数', () => {
    const params = parseStartParams({
      cwd: ABS,
      task: { type: 'command', target: '  pnpm dev ', cwd: ' web ', env: { A: '1' } },
      label: ' dev ',
      key: 'c1/t1',
    })
    expect(params).toEqual({
      cwd: ABS,
      task: { type: 'command', target: 'pnpm dev', cwd: 'web', env: { A: '1' } },
      label: 'dev',
      key: 'c1/t1',
    })
  })

  it('type 缺省为 command，拒绝未知类型、相对 cwd、非字符串 env', () => {
    expect(parseStartParams({ cwd: ABS, task: { target: 'x' } }).task.type).toBe('command')
    expect(() => parseStartParams({ cwd: ABS, task: { type: 'exe', target: 'x' } })).toThrow(/只能是/)
    expect(() => parseStartParams({ cwd: 'rel', task: { target: 'x' } })).toThrow(/绝对路径/)
    expect(() => parseStartParams({ cwd: ABS, task: { target: 'x', env: { A: 1 } } })).toThrow(/字符串/)
    expect(() => parseStartParams({ cwd: ABS, task: { target: 'x', env: { 'A=B': '1' } } })).toThrow(/无效/)
    expect(() => parseStartParams({ cwd: ABS })).toThrow(/task/)
  })

  it('解析旧版 task.os 覆盖', () => {
    const params = parseStartParams({
      cwd: ABS,
      task: { target: '', os: { windows: { target: ' a.bat ', type: 'bat' }, linux: { env: { M: 'l' } } } },
    })
    expect(params.task.os).toEqual({ windows: { target: 'a.bat', type: 'bat' }, linux: { env: { M: 'l' } } })
    expect(() => parseStartParams({ cwd: ABS, task: { target: 'x', os: { bsd: {} } } })).toThrow(/不支持/)
    expect(() => parseStartParams({ cwd: ABS, task: { target: 'x', os: 'windows' } })).toThrow(/对象/)
  })
})

describe('resolveTaskForOs', () => {
  it('覆盖字段替换、env 合并', () => {
    const task = {
      type: 'command' as const,
      target: 'python3 app.py',
      env: { A: '1', B: '1' },
      os: { windows: { target: 'python.exe app.py', env: { B: 'w' } } },
    }
    expect(resolveTaskForOs(task, 'windows')).toEqual({
      type: 'command',
      target: 'python.exe app.py',
      env: { A: '1', B: 'w' },
    })
    expect(resolveTaskForOs(task, 'linux')).toEqual({ type: 'command', target: 'python3 app.py', env: { A: '1', B: '1' } })
  })

  it('缺 target 或 BAT 跑在非 Windows 时报错', () => {
    expect(() => resolveTaskForOs({ type: 'command', target: '', os: { windows: { target: 'x' } } }, 'linux')).toThrow(/未配置/)
    expect(() => resolveTaskForOs({ type: 'bat', target: 'a.bat' }, 'macos')).toThrow(/BAT/)
  })

  it('覆盖里的空 cwd 清掉基础 cwd', () => {
    const resolved = resolveTaskForOs({ type: 'command', target: 'x', cwd: 'web', os: { linux: { cwd: '' } } }, 'linux')
    expect(resolved.cwd).toBeUndefined()
  })
})

describe('mergeEnv', () => {
  it('Windows 下大小写不敏感覆盖，并强制 FORCE_COLOR', () => {
    const env = mergeEnv({ Path: 'a', HOME: 'h', U: undefined }, { PATH: 'b' }, true)
    expect(env).toEqual({ HOME: 'h', FORCE_COLOR: '1', PATH: 'b' })
  })
  it('POSIX 区分大小写，task.env 可覆盖 FORCE_COLOR', () => {
    expect(mergeEnv({ Path: 'a' }, { PATH: 'b', FORCE_COLOR: '0' }, false)).toEqual({
      Path: 'a',
      PATH: 'b',
      FORCE_COLOR: '0',
    })
  })
})

describe('Windows 命令行构造', () => {
  it('command 经 cmd.exe /d /s /c 原样传递', () => {
    const plan = buildSpawnPlan({ type: 'command', target: 'echo "a b" && echo ok' }, 'windows', tools())
    expect(plan.file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(plan.args).toEqual(['/d', '/s', '/c', '"echo "a b" && echo ok"'])
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(plan.command).toBe('C:\\Windows\\system32\\cmd.exe /d /s /c "echo "a b" && echo ok"')
  })

  it('bat 与未知扩展名加引号并转反斜杠', () => {
    expect(buildSpawnPlan({ type: 'bat', target: 'bin/start dev.bat' }, 'windows', tools()).args[3]).toBe(
      '"".\\bin\\start dev.bat""',
    )
    expect(buildSpawnPlan({ type: 'bat', target: '..\\up.cmd' }, 'windows', tools()).args[3]).toBe('""..\\up.cmd""')
    expect(buildSpawnPlan({ type: 'script', target: '/D:/x/tool.exe' }, 'windows', tools()).args[3]).toBe(
      '""D:\\x\\tool.exe""',
    )
    expect(() => buildSpawnPlan({ type: 'bat', target: 'a"b.bat' }, 'windows', tools())).toThrow(/双引号/)
  })

  it('ps1 优先 pwsh，否则 powershell，都找不到报错', () => {
    const pwsh = buildSpawnPlan({ type: 'ps1', target: 'scripts/b.ps1' }, 'windows', tools({ pwsh: 'P:\\pwsh.exe', powershell: 'W:\\powershell.exe' }))
    expect(pwsh.file).toBe('P:\\pwsh.exe')
    expect(pwsh.args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\\b.ps1'])
    expect(pwsh.windowsVerbatimArguments).toBe(false)
    expect(buildSpawnPlan({ type: 'script', target: 'b.ps1' }, 'windows', tools({ powershell: 'W:\\ps.exe' })).file).toBe('W:\\ps.exe')
    expect(() => buildSpawnPlan({ type: 'ps1', target: 'b.ps1' }, 'windows', tools())).toThrow(/pwsh/)
  })

  it('sh 不使用 System32 的 WSL bash', () => {
    expect(() =>
      buildSpawnPlan({ type: 'sh', target: 'a.sh' }, 'windows', tools({ bash: 'C:\\Windows\\System32\\bash.exe' })),
    ).toThrow(/sh 或 bash/)
    const plan = buildSpawnPlan({ type: 'script', target: 'a.sh' }, 'windows', tools({ sh: 'G:\\Git\\usr\\bin\\sh.exe' }))
    expect(plan).toMatchObject({ file: 'G:\\Git\\usr\\bin\\sh.exe', args: ['a.sh'] })
  })

  it('script 按扩展名选择 python / node', () => {
    expect(buildSpawnPlan({ type: 'script', target: 't.py' }, 'windows', tools({ python: 'X:\\python.exe' }))).toMatchObject({
      file: 'X:\\python.exe',
      args: ['t.py'],
    })
    expect(buildSpawnPlan({ type: 'script', target: 't.mjs' }, 'windows', tools()).file).toBe('node')
  })

  it('拒绝多行命令与空命令', () => {
    expect(() => buildSpawnPlan({ type: 'command', target: 'a\nb' }, 'windows', tools())).toThrow(/换行/)
    expect(() => buildSpawnPlan({ type: 'command', target: '  ' }, 'windows', tools())).toThrow(/不能为空/)
  })
})

describe('POSIX 命令行构造', () => {
  it('command 走 sh -lc，允许多行', () => {
    expect(buildSpawnPlan({ type: 'command', target: 'cd web\npnpm dev' }, 'linux', tools())).toMatchObject({
      file: 'sh',
      args: ['-lc', 'cd web\npnpm dev'],
      windowsVerbatimArguments: false,
    })
  })

  it('sh / bat / ps1', () => {
    expect(buildSpawnPlan({ type: 'sh', target: 'run.sh' }, 'linux', tools()).args).toEqual(['run.sh'])
    expect(() => buildSpawnPlan({ type: 'bat', target: 'a.bat' }, 'linux', tools())).toThrow(/Windows/)
    expect(() => buildSpawnPlan({ type: 'script', target: 'a.cmd' }, 'macos', tools())).toThrow(/Windows/)
    expect(() => buildSpawnPlan({ type: 'ps1', target: 'a.ps1' }, 'linux', tools())).toThrow(/pwsh/)
    expect(buildSpawnPlan({ type: 'ps1', target: 'a.ps1' }, 'linux', tools({ pwsh: '/usr/bin/pwsh' })).file).toBe('/usr/bin/pwsh')
  })

  it('script 未知扩展名：可执行就直接执行，否则 sh', () => {
    const plan = buildSpawnPlan({ type: 'script', target: "bin/it's" }, 'linux', tools())
    expect(plan.file).toBe('sh')
    expect(plan.args[1]).toBe(`if [ -x 'bin/it'"'"'s' ]; then exec 'bin/it'"'"'s'; else exec /bin/sh 'bin/it'"'"'s'; fi`)
    expect(buildSpawnPlan({ type: 'script', target: 'run' }, 'linux', tools()).args[1]).toContain('./run')
    expect(buildSpawnPlan({ type: 'script', target: 'a.py' }, 'linux', tools({ python3: '/usr/bin/python3' })).file).toBe('/usr/bin/python3')
  })
})

describe('辅助函数', () => {
  it('platformToOs', () => {
    expect(platformToOs('win32')).toBe('windows')
    expect(platformToOs('darwin')).toBe('macos')
    expect(platformToOs('linux')).toBe('linux')
  })

  it('scriptKind 与 shellQuote', () => {
    expect(scriptKind('a/b.PS1')).toBe('ps1')
    expect(scriptKind('x.cmd')).toBe('bat')
    expect(scriptKind('.bashrc')).toBe('other')
    expect(shellQuote('a-b/c.sh')).toBe('a-b/c.sh')
    expect(shellQuote('a b')).toBe("'a b'")
  })

  it('displayCommand 给含空格参数加引号', () => {
    expect(displayCommand('pwsh', ['-File', 'a b.ps1'], false)).toBe('pwsh -File "a b.ps1"')
  })

  it('resolveWorkdir', () => {
    expect(resolveWorkdir('/p', undefined, path.posix)).toBe('/p')
    expect(resolveWorkdir('/p', 'web', path.posix)).toBe('/p/web')
    expect(resolveWorkdir('D:\\p', 'E:\\x', path.win32)).toBe('E:\\x')
  })

  it('findInPath 按 PATHEXT 查找', () => {
    const files = new Set(['C:\\bin\\pwsh.exe', '/usr/bin/sh'])
    const exists = (file: string): boolean => files.has(file)
    expect(findInPath('pwsh', { Path: 'C:\\none;C:\\bin', PATHEXT: '.COM;.EXE' }, true, exists)).toBe('C:\\bin\\pwsh.exe')
    expect(findInPath('pwsh.exe', { PATH: '"C:\\bin"' }, true, exists)).toBe('C:\\bin\\pwsh.exe')
    expect(findInPath('sh', { PATH: '/bin:/usr/bin' }, false, exists)).toBe('/usr/bin/sh')
    expect(findInPath('nope', { PATH: '/usr/bin' }, false, exists)).toBeNull()
  })
})
