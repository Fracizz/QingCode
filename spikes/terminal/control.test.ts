import { describe, expect, it } from 'vitest'
import {
  ControlLineDecoder,
  PtyUnavailableError,
  chooseBackend,
  clampSize,
  encodeControlLine,
  parsePythonProbe,
  parseScriptProbe,
  posixQuote,
} from './control.mjs'

const caps = (python: boolean, script: boolean, posix = true) => ({
  python3: { ok: python, version: '3.14.4' },
  script: { ok: script, version: 'script from util-linux 2.41.3' },
  posix,
})

describe('encodeControlLine / ControlLineDecoder', () => {
  it('把消息编成单行 JSON', () => {
    expect(encodeControlLine({ type: 'resize', cols: 120, rows: 40 })).toBe(
      '{"type":"resize","cols":120,"rows":40}\n',
    )
  })

  it('跨 chunk 拼行、忽略空行与坏行', () => {
    const decoder = new ControlLineDecoder()
    expect(decoder.push('{"type":"res')).toEqual([])
    expect(decoder.push('ized","cols":120}\n\n{bad json}\n{"type":"ready"}\n')).toEqual([
      { type: 'resized', cols: 120 },
      { type: 'ready' },
    ])
    expect(decoder.push(Buffer.from('{"type":"exit","code":7}\r\n'))).toEqual([
      { type: 'exit', code: 7 },
    ])
  })

  it('数组不是控制消息，reset 清空半行', () => {
    const decoder = new ControlLineDecoder()
    expect(decoder.push('[1,2,3]\n')).toEqual([])
    decoder.push('{"type":"pi')
    decoder.reset()
    expect(decoder.push('ng"}\n')).toEqual([])
  })
})

describe('clampSize / posixQuote', () => {
  it('尺寸规整到 1..1000 的整数', () => {
    expect(clampSize(undefined, 80)).toBe(80)
    expect(clampSize(120.9, 80)).toBe(120)
    expect(clampSize(0, 24)).toBe(1)
    expect(clampSize(5000, 24)).toBe(1000)
    expect(clampSize(Number.NaN, 24)).toBe(24)
  })

  it('单引号按 POSIX 规则转义', () => {
    expect(posixQuote('/bin/bash')).toBe("'/bin/bash'")
    expect(posixQuote("/tmp/a'b")).toBe("'/tmp/a'\\''b'")
  })
})

describe('chooseBackend 探测顺序', () => {
  it('auto 优先 python3 内联桥', () => {
    expect(chooseBackend(caps(true, true))).toBe('python')
  })

  it('python 不可用时降级到 script', () => {
    expect(chooseBackend(caps(false, true))).toBe('script')
  })

  it('两者都不可用报明确错误', () => {
    expect(() => chooseBackend(caps(false, false))).toThrow(PtyUnavailableError)
    expect(() => chooseBackend(caps(false, false))).toThrow(/python3/)
  })

  it('显式指定不可用后端也报明确错误', () => {
    expect(() => chooseBackend(caps(false, true), 'python')).toThrow(/python3 PTY 桥不可用/)
    expect(() => chooseBackend(caps(true, false), 'script')).toThrow(/script 兜底不可用/)
    expect(chooseBackend(caps(true, true), 'script')).toBe('script')
  })

  it('Windows 上两个 POSIX 后端都不可用', () => {
    expect(() => chooseBackend(caps(true, true, false))).toThrow(/ConPTY/)
  })
})

describe('探测输出解析', () => {
  it('python3 输出夹带告警仍能解析', () => {
    expect(parsePythonProbe('warning\n{"ok":true,"pty":true,"version":"3.14.4"}\n')).toEqual({
      ok: true,
      version: '3.14.4',
      detail: '',
    })
    expect(parsePythonProbe('{"ok":false,"pty":false}').ok).toBe(false)
    expect(parsePythonProbe('no json').ok).toBe(false)
  })

  it('script 必须同时具备 -q/-f/-e/-c', () => {
    const help = '-e, --return  -f, --flush  -c, --command  -q, --quiet'
    expect(parseScriptProbe('script from util-linux 2.41.3', help).ok).toBe(true)
    expect(parseScriptProbe('script from util-linux 2.41.3', '-q, --quiet').ok).toBe(false)
  })
})
