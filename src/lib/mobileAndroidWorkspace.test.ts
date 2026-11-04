import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceState, searchOffsets, terminalText } from '../../mobile/android/web/workspaceState.js'

const memoryStorage = () => {
  const entries = new Map<string, string>()
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
}

describe('mobile durable editing and submission recovery', () => {
  it('recovers drafts after reload, separates projects and never replays a pending submission', () => {
    const storage = memoryStorage()
    const first = createWorkspaceState({ storage })
    first.context('pc/session-1', 'project-a', 'A')
    first.drafts.set('pc/session-1', '中文需求\n代码😀')
    first.submit('pc/session-1', '可能已经发送的指令')
    first.context('pc/session-2', 'project-b', 'B')
    first.drafts.set('pc/session-2', 'other')
    const restored = createWorkspaceState({ storage })
    expect(restored.drafts.get('pc/session-1')).toBe('中文需求\n代码😀')
    expect(restored.recent('pc/session-1')[0].state).toBe('unknown')
    expect(restored.recoverable('pc', 'project-a', 'pc/new').map(room => room.draft)).toEqual(['中文需求\n代码😀'])
    expect(restored.recoverable('other-host', 'project-a', '')).toEqual([])
  })

  it('settles only the intended submission and retains originals across newer drafts', () => {
    const state = createWorkspaceState({ storage: memoryStorage() })
    const id = state.submit('pc/a', 'old instruction')
    const other = state.submit('pc/b', 'another instruction')
    state.drafts.set('pc/a', 'new draft')
    state.settle('pc/a', id, 'received')
    state.settle('pc/a', other, 'unknown')
    expect(state.recent('pc/a')[0]).toMatchObject({ text: 'old instruction', state: 'received' })
    expect(state.drafts.get('pc/a')).toBe('new draft')
    expect(state.recent('pc/b')[0].state).toBe('sending')
  })

  it('moves all draft metadata and receipts with a changed host and removes them on forgetting', () => {
    const storage = memoryStorage()
    const state = createWorkspaceState({ storage })
    state.context('old/session', 'p', 'Project')
    state.drafts.set('old/session', 'draft')
    const pending = state.submit('old/session', 'submitted')
    state.renameHost('old', 'new')
    expect(state.drafts.get('old/session')).toBeUndefined()
    expect(state.recoverable('new', 'p', '')[0].draft).toBe('draft')
    expect(state.recent('new/session')[0].text).toBe('submitted')
    state.settle('old/session', pending, 'received')
    expect(state.recent('new/session')[0].state).toBe('unknown')
    state.removeHost('new')
    expect(createWorkspaceState({ storage }).drafts.get('new/session')).toBeUndefined()
    expect(state.recent('new/session')).toEqual([])
  })

  it('keeps editing usable when phone storage is unavailable and ignores late removed receipts', () => {
    const onError = vi.fn()
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    const state = createWorkspaceState({ storage, onError })
    state.drafts.set('pc/a', 'still editable')
    expect(state.drafts.get('pc/a')).toBe('still editable')
    expect(onError).toHaveBeenCalled()
    const id = state.submit('pc/a', 'pending')
    state.removeHost('pc')
    state.settle('pc/a', id, 'received')
    expect(state.recent('pc/a')).toEqual([])
  })
})

describe('mobile read-only output', () => {
  it('searches literal Unicode text without treating it as a regular expression', () => {
    expect(searchOffsets('a+b 中文 A+B', 'a+b')).toEqual([{ start: 0, end: 3 }, { start: 7, end: 10 }])
    expect(searchOffsets('😀 中文\n中文', '中文')).toEqual([{ start: 3, end: 5 }, { start: 6, end: 8 }])
    expect(searchOffsets('anything', '[')).toEqual([])
    expect(searchOffsets('anything', '')).toEqual([])
    expect(searchOffsets('x'.repeat(10000), 'x')).toHaveLength(500)
  })

  it('joins only terminal soft wraps and preserves real line breaks', () => {
    const lines = [{ text: 'long ', wrapped: false }, { text: 'line', wrapped: true }, { text: 'next', wrapped: false }]
    const term = { buffer: { active: { length: lines.length, getLine: (index: number) => index >= lines.length ? undefined : ({
      isWrapped: lines[index].wrapped, translateToString: () => lines[index].text,
    }) } } }
    expect(terminalText(term)).toBe('long line\nnext')
  })
})
