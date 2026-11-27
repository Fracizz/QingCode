import { describe, expect, it } from 'vitest'
import { applyThreadPrefs, archivedThreadSummaries, emptyThreadPrefs, isInactiveForArchive, parseThreadPrefs, toggleKey } from './threadPrefs'
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

it('归档列表直接采用目标机返回的归档会话，并保留本地名称', () => {
  const prefs = parseThreadPrefs('{"local":{"names":{"claude:old":"旧项目"}}}').local
  expect(archivedThreadSummaries([
    thread('native', 3), thread('old', 2, 'claude'), thread('pi-archived', 1, 'pi'),
  ], prefs).map(({ title }) => title)).toEqual(['native', '旧项目', 'pi-archived'])
})

it('只归档有时间记录、未置顶、未恢复且已超过期限的空闲会话', () => {
  const prefs = {
    ...emptyThreadPrefs(),
    pinned: { 'codex:pinned': 1 },
    restoredAt: { 'codex:restored': 101 },
    hidden: { 'codex:hidden': true as const },
  }
  const candidates = [
    thread('at-cutoff', 100), thread('fresh', 101), thread('no-timestamp', 0),
    thread('pinned', 50), thread('restored', 50), thread('hidden', 50),
    { ...thread('running', 50), activity: 'running' as const },
    { ...thread('pending', 50), activity: 'pending' as const },
  ]
  expect(candidates.filter((item) => isInactiveForArchive(item, prefs, 100)).map(({ id }) => id)).toEqual(['at-cutoff'])
})

describe('parseThreadPrefs', () => {
  it('丢弃非法字段', () => {
    const parsed = parseThreadPrefs(
      JSON.stringify({ t1: { pinned: { a: 1, b: 'x' }, unread: { a: true, b: 1 }, names: { a: ' ' }, hidden: [], restoredAt: { a: 10, b: 'x' } } }),
    )
    expect(parsed.t1).toEqual({ pinned: { a: 1 }, unread: { a: true }, names: {}, hidden: {}, restoredAt: { a: 10 }, revisionTurns: {} })
  })

  it('恢复已保存的修订轮次', () => {
    const parsed = parseThreadPrefs('{"local":{"revisionTurns":{"codex:fork":"revised-turn","codex:invalid":false}}}')
    expect(parsed.local?.revisionTurns).toEqual({ 'codex:fork': 'revised-turn' })
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
