import { describe, expect, it } from 'vitest'
import { formatDirtyDiscardCopy, getDirtyTabs } from './dirtyTabs'
import type { EditorTab } from '../types'

function tab(name: string, dirty: boolean): EditorTab {
  return {
    id: name,
    name,
    path: `/tmp/${name}`,
    dirty,
    language: 'plain',
  }
}

describe('getDirtyTabs', () => {
  it('filters dirty tabs only', () => {
    expect(getDirtyTabs([tab('a.ts', false), tab('b.ts', true)])).toEqual([tab('b.ts', true)])
  })
})

describe('formatDirtyDiscardCopy', () => {
  const t = (source: string, values?: Record<string, string | number>) => {
    if (!values) return source
    return source.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
  }

  it('lists up to three file names', () => {
    const copy = formatDirtyDiscardCopy([tab('a.ts', true), tab('b.ts', true)], '关闭', t)
    expect(copy.title).toBe('未保存的更改')
    expect(copy.message).toContain('「a.ts」')
    expect(copy.message).toContain('「b.ts」')
    expect(copy.detail).toContain('关闭')
    expect(copy.confirmLabel).toBe('放弃更改')
  })

  it('adds remainder when more than three dirty tabs', () => {
    const dirty = [tab('a', true), tab('b', true), tab('c', true), tab('d', true)]
    const copy = formatDirtyDiscardCopy(dirty, '切换项目', t)
    expect(copy.message).toContain('等 4 个文件')
  })
})
