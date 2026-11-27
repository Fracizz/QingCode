import { describe, expect, it } from 'vitest'
import { applyThreadPrefs, emptyThreadPrefs, parseThreadPrefs, toggleKey } from './threadPrefs'
import type { ThreadSummary } from './threads'

const thread = (id: string, updatedAt: number, agent: ThreadSummary['agent'] = 'codex'): ThreadSummary => ({
  id,
  title: id,
  preview: '',
  cwd: '/w',
  updatedAt,
  agent,
})

describe('applyThreadPrefs', () => {
  it('置顶排最前且按置顶时间倒序，其余保持原序', () => {
    const prefs = { ...emptyThreadPrefs(), pinned: { 'codex:c': 1, 'codex:b': 2 } }
    const out = applyThreadPrefs([thread('a', 3), thread('b', 2), thread('c', 1), thread('d', 0)], prefs)
    expect(out.map((t) => t.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('过滤本地归档并套用本地名称', () => {
    const prefs = {
      ...emptyThreadPrefs(),
      hidden: { 'claude:x': true as const },
      names: { 'claude:y': '新名字' },
    }
    const out = applyThreadPrefs([thread('x', 2, 'claude'), thread('y', 1, 'claude')], prefs)
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe('新名字')
  })

  it('没有偏好时原样返回', () => {
    expect(applyThreadPrefs([thread('a', 1)], undefined).map((t) => t.id)).toEqual(['a'])
  })
})

describe('parseThreadPrefs', () => {
  it('丢弃非法字段', () => {
    const parsed = parseThreadPrefs(
      JSON.stringify({ t1: { pinned: { a: 1, b: 'x' }, unread: { a: true, b: 1 }, names: { a: ' ' }, hidden: [] } }),
    )
    expect(parsed.t1).toEqual({ pinned: { a: 1 }, unread: { a: true }, names: {}, hidden: {} })
  })

  it('损坏的 JSON 返回空', () => {
    expect(parseThreadPrefs('{')).toEqual({})
    expect(parseThreadPrefs(null)).toEqual({})
  })
})

describe('toggleKey', () => {
  it('undefined 删除键', () => {
    expect(toggleKey({ a: 1 }, 'a', undefined)).toEqual({})
    expect(toggleKey({}, 'a', 1)).toEqual({ a: 1 })
  })
})
