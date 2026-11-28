import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextWindowStore, defaultModelWindow, modelKey, parseContextWindowRecord, resultModelWindow } from './contextWindows'

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

  it('没学到窗口时按内置清单兜底，学到的优先', () => {
    const store = new ContextWindowStore(undefined, () => undefined)
    expect(store.lookup('fresh', 'claude-sonnet-5-5')).toBe(1_000_000)
    expect(store.lookup('fresh', 'claude-haiku-4-5-20251001')).toBe(200_000)
    store.record('learned', 'claude-sonnet-5-5', 200_000)
    expect(store.lookup('learned', 'claude-sonnet-5-5')).toBe(200_000)
  })

  it('有两档窗口的模型读数超过 200K 时按 1M 算，未知模型不猜', () => {
    expect(defaultModelWindow('claude-opus-4-8', 150_000)).toBe(200_000)
    expect(defaultModelWindow('claude-opus-4-8', 350_000)).toBe(1_000_000)
    expect(defaultModelWindow('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(defaultModelWindow('claude-haiku-5')).toBeNull()
    expect(defaultModelWindow('<synthetic>')).toBeNull()
    expect(defaultModelWindow(null)).toBeNull()
  })

  it('损坏的记录按空表处理', () => {
    expect(parseContextWindowRecord({ sessions: { a: 'x', b: 5 }, models: null })).toEqual({ sessions: { b: 5 }, models: {} })
    expect(parseContextWindowRecord('bad')).toEqual({ sessions: {}, models: {} })
  })
})
