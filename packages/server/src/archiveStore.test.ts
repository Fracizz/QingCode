import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArchiveStore, parseArchiveRecord } from './archiveStore'

describe('ArchiveStore', () => {
  it('丢弃非法条目，损坏文件按空表处理', () => {
    expect(parseArchiveRecord({ a: 1, b: 'x', '': 2, c: Number.NaN })).toEqual({ a: 1 })
    expect(parseArchiveRecord([1, 2])).toEqual({})
    expect(parseArchiveRecord(null)).toEqual({})
  })

  it('按 Agent 分文件持久化，重复设置不算变化', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qn-archive-'))
    try {
      const store = new ArchiveStore(dir, 'pi', () => undefined)
      expect(store.set('t1', true)).toBe(true)
      expect(store.set('t1', true)).toBe(false)
      expect(new ArchiveStore(dir, 'pi', () => undefined).has('t1')).toBe(true)
      expect(new ArchiveStore(dir, 'claude', () => undefined).has('t1')).toBe(false)
      expect(Object.keys(JSON.parse(readFileSync(path.join(dir, 'archives', 'pi.json'), 'utf8')))).toEqual(['t1'])
      expect(store.set('t1', false)).toBe(true)
      expect(new ArchiveStore(dir, 'pi', () => undefined).has('t1')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有状态目录时只在内存里生效', () => {
    const store = new ArchiveStore(undefined, 'claude', () => undefined)
    expect(store.set('t1', true)).toBe(true)
    expect(store.has('t1')).toBe(true)
  })
})
