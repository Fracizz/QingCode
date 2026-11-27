import { describe, expect, it } from 'vitest'
import { MAX_LINES, appendOutput, clearOutput, emptyOutput, outputText } from './outputModel'
import { configStatus, runStatusText, runTabs } from './runView'
import type { RunInfo } from './types'

describe('outputModel', () => {
  it('按行切分，未结束的行留在 current', () => {
    let out = appendOutput(emptyOutput(), 'a\nb', 'stdout', 1)
    expect(out.lines.map((l) => l.segments.map((s) => s.text).join(''))).toEqual(['a'])
    expect(out.current.map((s) => s.text).join('')).toBe('b')
    out = appendOutput(out, 'c\n', 'stdout', 2)
    expect(outputText(out)).toBe('a\nbc')
    expect(out.lastSeq).toBe(2)
  })

  it('\\r\\n 视为换行（含跨块），单独 \\r 覆盖当前行', () => {
    let out = appendOutput(emptyOutput(), 'x\r', 'stdout')
    out = appendOutput(out, '\ny', 'stdout')
    expect(outputText(out)).toBe('x\ny')
    const progress = appendOutput(emptyOutput(), '10%\r50%\r100%\n', 'stdout')
    expect(outputText(progress)).toBe('100%')
    let split = appendOutput(emptyOutput(), '10%\r', 'stdout')
    split = appendOutput(split, '20%', 'stdout')
    expect(outputText(split)).toBe('20%')
  })

  it('stderr 片段带标记，ANSI 状态跨块保留', () => {
    let out = appendOutput(emptyOutput(), '\u001b[32mok', 'stdout')
    out = appendOutput(out, ' still\n', 'stdout')
    expect(out.lines[0]!.segments).toEqual([{ text: 'ok still', style: { fg: '#23d18b' } }])
    out = appendOutput(out, 'bad\n', 'stderr')
    expect(out.lines[1]!.segments[0]).toMatchObject({ text: 'bad', err: true })
  })

  it(`最多保留 ${MAX_LINES} 行`, () => {
    const out = appendOutput(emptyOutput(), 'l\n'.repeat(MAX_LINES + 10), 'stdout')
    expect(out.lines).toHaveLength(MAX_LINES)
    expect(out.dropped).toBe(true)
    expect(out.lines[0]!.id).toBe(11)
  })

  it('清空保留 seq', () => {
    const out = clearOutput(appendOutput(emptyOutput(), 'a\nb', 'stdout', 5))
    expect(out.lines).toEqual([])
    expect(out.current).toEqual([])
    expect(out.lastSeq).toBe(5)
  })
})

const run = (patch: Partial<RunInfo>): RunInfo => ({
  runId: 'r',
  label: 'l',
  cwd: '/p',
  workdir: '/p',
  command: 'x',
  pid: 1,
  startedAt: 0,
  lastSeq: 0,
  ...patch,
})

describe('runView', () => {
  it('runTabs：同键只留最新，隐藏已结束的', () => {
    const runs = [
      run({ runId: 'a', key: 'c/t', startedAt: 1, endedAt: 2, exitCode: 0 }),
      run({ runId: 'b', key: 'c/t', startedAt: 3 }),
      run({ runId: 'c', startedAt: 2, endedAt: 4, exitCode: 0 }),
      run({ runId: 'd', startedAt: 5, endedAt: 6, exitCode: 1 }),
    ]
    expect(runTabs(runs, {}).map((r) => r.runId)).toEqual(['c', 'b', 'd'])
    expect(runTabs(runs, { c: true, b: true }).map((r) => r.runId)).toEqual(['b', 'd'])
  })

  it('configStatus', () => {
    const config = { id: 'c', name: 'c', tasks: [] }
    expect(configStatus(config, [])).toBe('idle')
    expect(configStatus(config, [run({ key: 'c/t' })])).toBe('running')
    const failed = run({ runId: 'f', key: 'c/t', endedAt: 1, exitCode: 1 })
    expect(configStatus(config, [failed])).toBe('failed')
    expect(configStatus(config, [failed], { f: true })).toBe('ok')
    expect(configStatus(config, [failed, run({ runId: 'g', key: 'c/t', startedAt: 5, endedAt: 6, exitCode: 0 })])).toBe('ok')
    expect(configStatus(config, [run({ key: 'other/t' })])).toBe('idle')
  })

  it('runStatusText', () => {
    expect(runStatusText(run({ pid: 42 }))).toBe('运行中 · PID 42')
    expect(runStatusText(run({ endedAt: 1, exitCode: 0 }))).toBe('已退出（0）')
    expect(runStatusText(run({ endedAt: 1, exitCode: null, signal: 'SIGTERM' }))).toBe('已终止（SIGTERM）')
    expect(runStatusText(run({ endedAt: 1, exitCode: 1 }), true)).toBe('已停止')
  })
})
