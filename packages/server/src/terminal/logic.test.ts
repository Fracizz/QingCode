import { describe, expect, it } from 'vitest'
import { WorkspaceError } from '../workspace/registry'
import {
  ControlLineDecoder,
  MAX_WRITE_BYTES,
  base64DecodedLength,
  buildEnv,
  chooseBackend,
  clampSize,
  defaultShell,
  encodeControlLine,
  normalizeSignal,
  parseAttachParams,
  parseEnv,
  parseOpenParams,
  parsePythonProbe,
  parseResizeParams,
  parseScriptProbe,
  parseSnapshotParams,
  parseTermId,
  parseWriteParams,
  posixQuote,
  scriptCommand,
  type Capabilities,
} from './logic'

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof WorkspaceError ? err.code : 'other'
  }
  return undefined
}

describe('参数校验', () => {
  it('termId 只接受安全字符', () => {
    expect(parseTermId('t-abc_1.2:3', 'x')).toBe('t-abc_1.2:3')
    expect(codeOf(() => parseTermId('', 'x'))).toBe('params')
    expect(codeOf(() => parseTermId('a b', 'x'))).toBe('params')
    expect(codeOf(() => parseTermId('x'.repeat(65), 'x'))).toBe('params')
    expect(codeOf(() => parseTermId(1, 'x'))).toBe('params')
  })

  it('尺寸：缺省/0/NaN 用默认值，超大截到 1000', () => {
    expect(clampSize(undefined, 80)).toBe(80)
    expect(clampSize(0, 24)).toBe(24)
    expect(clampSize(Number.NaN, 24)).toBe(24)
    expect(clampSize(120.7, 80)).toBe(120)
    expect(clampSize(5000, 80)).toBe(1000)
  })

  it('term.open：cwd 必须是绝对路径，其余字段给默认值', () => {
    const req = parseOpenParams({ cwd: '/home/u/proj/../proj' }, 'linux')
    expect(req).toEqual({ cwd: '/home/u/proj', args: [], cols: 80, rows: 24, env: {}, backend: 'auto' })
    expect(codeOf(() => parseOpenParams({ cwd: 'relative' }, 'linux'))).toBe('params')
    expect(codeOf(() => parseOpenParams({ cwd: 'C:\\x' }, 'linux'))).toBe('params')
    expect(parseOpenParams({ cwd: 'C:\\x' }, 'win32').cwd).toBe('C:\\x')
    // SFTP 风格项目根在 Windows 上转成盘符路径
    expect(parseOpenParams({ cwd: '/D:/code/repo' }, 'win32').cwd).toBe('D:\\code\\repo')
    expect(parseOpenParams({ cwd: 'D:/code/repo' }, 'win32').cwd).toBe('D:\\code\\repo')
    expect(codeOf(() => parseOpenParams({}, 'linux'))).toBe('params')
    expect(codeOf(() => parseOpenParams({ cwd: '/a\0b' }, 'linux'))).toBe('params')
  })

  it('term.open：shell/args/backend/termId 校验', () => {
    const req = parseOpenParams(
      { termId: 't1', cwd: '/', shell: '/bin/bash', args: ['-l'], cols: 132, rows: 43, backend: 'script' },
      'linux',
    )
    expect(req).toMatchObject({ termId: 't1', shell: '/bin/bash', args: ['-l'], cols: 132, rows: 43, backend: 'script' })
    expect(codeOf(() => parseOpenParams({ cwd: '/', shell: '' }, 'linux'))).toBe('params')
    expect(codeOf(() => parseOpenParams({ cwd: '/', args: 'x' }, 'linux'))).toBe('params')
    expect(codeOf(() => parseOpenParams({ cwd: '/', args: [1] }, 'linux'))).toBe('params')
    expect(codeOf(() => parseOpenParams({ cwd: '/', backend: 'winpty' }, 'linux'))).toBe('params')
    expect(codeOf(() => parseOpenParams({ cwd: '/', termId: 'bad id' }, 'linux'))).toBe('params')
  })

  it('env：拒绝非法变量名与注入类变量，错误信息不回显值', () => {
    expect(parseEnv({ FOO: 'bar', _X1: '' })).toEqual({ FOO: 'bar', _X1: '' })
    expect(codeOf(() => parseEnv({ 'A-B': 'x' }))).toBe('params')
    expect(codeOf(() => parseEnv({ LD_PRELOAD: '/x.so' }))).toBe('params')
    expect(codeOf(() => parseEnv({ DYLD_INSERT_LIBRARIES: 'x' }))).toBe('params')
    expect(codeOf(() => parseEnv({ PYTHONPATH: 'x' }))).toBe('params')
    expect(codeOf(() => parseEnv({ QN_TOKEN: 'x' }))).toBe('params')
    expect(codeOf(() => parseEnv({ A: 1 }))).toBe('params')
    expect(codeOf(() => parseEnv([]))).toBe('params')
    try {
      parseEnv({ SECRET: 'tok\0en-value' })
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('en-value')
    }
  })

  it('term.write：base64 解码、1 MiB 上限先于解码判断', () => {
    expect(parseWriteParams({ termId: 't', data: Buffer.from('ls\r').toString('base64') }).data.toString()).toBe('ls\r')
    expect(parseWriteParams({ termId: 't', data: '' }).data.byteLength).toBe(0)
    const big = Buffer.alloc(MAX_WRITE_BYTES + 1).toString('base64')
    expect(codeOf(() => parseWriteParams({ termId: 't', data: big }))).toBe('term_input_too_large')
    const max = Buffer.alloc(MAX_WRITE_BYTES).toString('base64')
    expect(parseWriteParams({ termId: 't', data: max }).data.byteLength).toBe(MAX_WRITE_BYTES)
    expect(codeOf(() => parseWriteParams({ termId: 't', data: 'not base64!' }))).toBe('params')
    expect(codeOf(() => parseWriteParams({ termId: 't', data: 'abc' }))).toBe('params')
    expect(codeOf(() => parseWriteParams({ termId: 't' }))).toBe('params')
  })

  it('base64DecodedLength 与真实解码一致', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      expect(base64DecodedLength(Buffer.alloc(n).toString('base64'))).toBe(n)
    }
  })

  it('term.resize / term.attach / term.snapshot', () => {
    expect(parseResizeParams({ termId: 't', cols: 100, rows: 30 })).toEqual({ termId: 't', cols: 100, rows: 30 })
    expect(codeOf(() => parseResizeParams({ termId: 't', cols: 0, rows: 30 }))).toBe('params')
    expect(codeOf(() => parseResizeParams({ termId: 't', cols: '1', rows: 30 }))).toBe('params')
    expect(parseAttachParams({ termId: 't' })).toEqual({ termId: 't', sinceSeq: 0 })
    expect(parseAttachParams({ termId: 't', sinceSeq: 7.9 })).toEqual({ termId: 't', sinceSeq: 7 })
    expect(codeOf(() => parseAttachParams({ termId: 't', sinceSeq: -1 }))).toBe('params')
    const snap = parseSnapshotParams({ termId: 't', seq: 3, data: 'AAA=', cols: 90, rows: 20 })
    expect(snap).toEqual({ termId: 't', seq: 3, data: 'AAA=', cols: 90, rows: 20 })
    expect(codeOf(() => parseSnapshotParams({ termId: 't', seq: 1.5, data: '' }))).toBe('params')
  })
})

describe('环境与 shell', () => {
  it('默认 shell 取 $SHELL 绝对路径，否则 /bin/sh', () => {
    expect(defaultShell({ SHELL: '/bin/zsh' }, 'linux')).toBe('/bin/zsh')
    expect(defaultShell({ SHELL: 'zsh' }, 'linux')).toBe('/bin/sh')
    expect(defaultShell({}, 'linux')).toBe('/bin/sh')
  })

  it('Windows 默认 shell 取 ComSpec 的绝对路径，否则 cmd.exe', () => {
    const command = 'C:/Windows/System32/cmd.exe'
    expect(defaultShell({ ComSpec: command }, 'win32')).toBe(command)
    expect(defaultShell({ COMSPEC: 'relative/cmd.exe' }, 'win32')).toBe('cmd.exe')
    expect(defaultShell({ SHELL: '/bin/zsh' }, 'win32')).toBe('cmd.exe')
  })

  it('buildEnv 去掉 daemon 自身变量，补 TERM/COLORTERM/COLUMNS/LINES', () => {
    const env = buildEnv(
      { PATH: '/usr/bin', TERM: 'dumb', QN_STATE: 'x', ELECTRON_RUN_AS_NODE: '1', LD_LIBRARY_PATH: '/opt/lib', U: undefined },
      { FOO: 'bar' },
      120,
      40,
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/lib',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FOO: 'bar',
      COLUMNS: '120',
      LINES: '40',
    })
    expect(buildEnv({ TERM: 'screen' }, { COLORTERM: '24bit' }, 80, 24)).toMatchObject({ TERM: 'screen', COLORTERM: '24bit' })
  })
})

describe('后端选择与探测解析', () => {
  const ok = { ok: true, version: '1', detail: '' }
  const no = { ok: false, version: '', detail: '缺失' }
  const caps = (python3: typeof ok, script: typeof ok, posix = true): Capabilities => ({ posix, python3, script })

  it('auto：python3 优先，其次 script，都没有时 pty_unavailable 信息', () => {
    expect(chooseBackend(caps(ok, ok))).toEqual({ ok: true, backend: 'python' })
    expect(chooseBackend(caps(no, ok))).toEqual({ ok: true, backend: 'script' })
    const none = chooseBackend(caps(no, no))
    expect(none.ok).toBe(false)
    const win = chooseBackend(caps(no, no, false))
    expect(!win.ok && win.message).toContain('ConPTY')
  })

  it('显式偏好不满足时不静默回退', () => {
    expect(chooseBackend(caps(no, ok), 'python').ok).toBe(false)
    expect(chooseBackend(caps(ok, no), 'script').ok).toBe(false)
    expect(chooseBackend(caps(ok, ok), 'script')).toEqual({ ok: true, backend: 'script' })
    expect(chooseBackend(caps(ok, ok), 'conpty').ok).toBe(false)
  })

  it('接入原生后端（T31）后 auto 优先用它', () => {
    const withNative: Capabilities = { ...caps(no, no, false), native: { ok: true, backend: 'conpty', detail: '' } }
    expect(chooseBackend(withNative)).toEqual({ ok: true, backend: 'conpty' })
    expect(chooseBackend(withNative, 'conpty')).toEqual({ ok: true, backend: 'conpty' })
  })

  it('python 探测容忍前后杂讯', () => {
    expect(parsePythonProbe('warn\n{"ok": true, "pty": true, "version": "3.14.4"}\n')).toEqual({ ok: true, version: '3.14.4', detail: '' })
    expect(parsePythonProbe('{"ok": false, "pty": true}').ok).toBe(false)
    expect(parsePythonProbe('').ok).toBe(false)
    expect(parsePythonProbe('{bad}').ok).toBe(false)
  })

  it('script 探测要求 util-linux 长选项', () => {
    const help = ' -q, --quiet\n -f, --flush\n -e, --return\n -c, --command <command>'
    expect(parseScriptProbe('script from util-linux 2.41.3\n', help)).toEqual({ ok: true, version: 'script from util-linux 2.41.3', detail: '' })
    expect(parseScriptProbe('', 'usage: script [-adfkpqr]').ok).toBe(false)
  })
})

describe('script 命令与引号', () => {
  it('posixQuote 能安全包住单引号', () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`)
    expect(posixQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`)
  })

  it('scriptCommand 先 stty 设尺寸再 exec', () => {
    expect(scriptCommand('/bin/bash', ['-l'], 100, 30)).toBe(`stty rows 30 cols 100 2>/dev/null; exec '/bin/bash' '-l'`)
  })
})

describe('控制通道', () => {
  it('编码为单行 JSON', () => {
    expect(encodeControlLine({ type: 'resize', cols: 1, rows: 2 })).toBe('{"type":"resize","cols":1,"rows":2}\n')
  })

  it('增量解码：半行、坏行、非对象都不影响后续', () => {
    const d = new ControlLineDecoder()
    expect(d.push('{"type":"re')).toEqual([])
    expect(d.push('ady","pid":5}\n{bad}\n[1]\n\n')).toEqual([{ type: 'ready', pid: 5 }])
    expect(d.push(Buffer.from('{"type":"exit","code":7}\n'))).toEqual([{ type: 'exit', code: 7 }])
  })

  it('信号编号转名字', () => {
    expect(normalizeSignal(1, { SIGHUP: 1, SIGKILL: 9 })).toBe('SIGHUP')
    expect(normalizeSignal(99, {})).toBe('SIG99')
    expect(normalizeSignal('SIGTERM')).toBe('SIGTERM')
    expect(normalizeSignal(null)).toBeNull()
    expect(normalizeSignal(0)).toBeNull()
  })
})
