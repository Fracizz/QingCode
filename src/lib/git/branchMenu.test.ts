import { describe, expect, it } from 'vitest'
import {
  buildBranchMenuRows,
  branchMenuViewportHeight,
  filterGitBranches,
  selectableBranchMenuRows,
} from './branchMenu'
import type { GitBranchList } from './git'

const labels = {
  local: '本地分支',
  remote: '远程分支',
  noLocal: '暂无本地分支',
  noMatch: '没有匹配的分支',
  loading: '正在读取分支…',
}

const sample: GitBranchList = {
  local: [
    { name: 'main', current: true, upstream: 'origin/main' },
    { name: 'feature/demo', current: false, upstream: null },
    { name: 'codex/upgrade', current: false, upstream: 'origin/codex/upgrade' },
  ],
  remote: ['origin/main', 'origin/feature/demo', 'origin/codex/upgrade'],
}

describe('filterGitBranches', () => {
  it('matches branch names and upstream refs', () => {
    const filtered = filterGitBranches(sample, 'codex')
    expect(filtered.local.map(branch => branch.name)).toEqual(['codex/upgrade'])
    expect(filtered.remote).toEqual(['origin/codex/upgrade'])
  })
})

describe('buildBranchMenuRows', () => {
  it('builds grouped rows with counts', () => {
    const rows = buildBranchMenuRows(sample, '', labels)
    expect(rows[0]).toMatchObject({ type: 'header', label: '本地分支', count: 3 })
    expect(rows.filter(row => row.type === 'local').length).toBe(3)
    expect(rows.some(row => row.type === 'header' && row.label === '远程分支')).toBe(true)
  })

  it('shows an empty-state row when the filter has no matches', () => {
    const rows = buildBranchMenuRows(sample, 'missing-branch', labels)
    expect(rows.some(row => row.type === 'empty' && row.label === '没有匹配的分支')).toBe(true)
    expect(selectableBranchMenuRows(rows)).toEqual([])
  })
})

describe('selectableBranchMenuRows', () => {
  it('skips the current branch but keeps remote refs', () => {
    const rows = buildBranchMenuRows(sample, '', labels)
    expect(selectableBranchMenuRows(rows)).toEqual([
      'feature/demo',
      'codex/upgrade',
      'origin/main',
      'origin/feature/demo',
      'origin/codex/upgrade',
    ])
  })
})

describe('branchMenuViewportHeight', () => {
  it('caps the viewport at ten branches while keeping later branches searchable', () => {
    const list: GitBranchList = {
      local: Array.from({ length: 30 }, (_, index) => ({
        name: `topic-${index}`,
        current: index === 0,
        upstream: null,
      })),
      remote: [],
    }
    const rows = buildBranchMenuRows(list, '', labels)
    expect(branchMenuViewportHeight(rows, 13)).toBe(26 + 10 * 34)
    expect(rows.filter(row => row.type === 'local')).toHaveLength(30)
    const filtered = buildBranchMenuRows(list, 'topic-29', labels)
    expect(branchMenuViewportHeight(filtered, 13)).toBe(26 + 34)
    expect(selectableBranchMenuRows(filtered)).toEqual(['topic-29'])
  })

  it('counts branches across groups and includes scaled upstream and section rows', () => {
    const rows = buildBranchMenuRows(sample, '', labels)
    expect(branchMenuViewportHeight(rows, 13)).toBe(2 * 26 + 2 * 44 + 34 + 3 * 32)
    expect(branchMenuViewportHeight(rows, 26)).toBe(2 * (2 * 26 + 2 * 44 + 34 + 3 * 32))
    expect(branchMenuViewportHeight(buildBranchMenuRows(null, '', labels), 13)).toBe(34)
  })
})
