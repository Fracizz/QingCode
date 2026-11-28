import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextWindowStore, modelKey, parseContextWindowRecord, resultModelWindow } from './contextWindows'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Claude 上下文窗口记录', () => {
  it('从 result.modelUsage 取窗口最大的主模型，优先规范模型名', () => {
    expect(resultModelWindow({ modelUsage: {
      'claude-haiku-5': { contextWindow: 200_000 },
      'claude-opus-5-5[1m]': { contextWindow: 1_000_000, canonicalModel: 'claude-opus-5-5' },
    } })).toEqual({ model: 'claude-opus-5-5', window: 1_000_000 })
    expect(resultModelWindow({ modelUsage: { x: { contextWindow: 0 } } })).toBeNull()
    expect(resultModelWindow({})).toBeNull()
  })

  it('模型名去掉 [1m] 后缀并忽略占位模型', () => {
    expect(modelKey('Claude-Sonnet-5-5[1m]')).toBe('claude-sonnet-5-5')
    expect(modelKey('<synthetic>')).toBeNull()
    expect(modelKey(null)).toBeNull()
  })

  it('先按会话、再按模型查找，并在重启后从状态目录读回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-ctx-'))
    dirs.push(dir)
    const store = new ContextWindowStore(dir, () => undefined)
    store.record('s1', 'claude-opus-5-5', 1_000_000)
    store.record('s2', null, 200_000)
    const reopened = new ContextWindowStore(dir, () => undefined)
    expect(reopened.lookup('s1', null)).toBe(1_000_000)
    expect(reopened.lookup('s2', 'claude-opus-5-5')).toBe(200_000)
    expect(reopened.lookup('cli-only', 'claude-opus-5-5')).toBe(1_000_000)
    expect(reopened.lookup('cli-only', 'claude-haiku-5')).toBeNull()
  })

  it('损坏的记录按空表处理', () => {
    expect(parseContextWindowRecord({ sessions: { a: 'x', b: 5 }, models: null })).toEqual({ sessions: { b: 5 }, models: {} })
    expect(parseContextWindowRecord('bad')).toEqual({ sessions: {}, models: {} })
  })
})
