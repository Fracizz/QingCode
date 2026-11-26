import { describe, expect, it } from 'vitest'
import type { FsReadResult } from '@qn/protocol'
import type { OpenRequest } from '../workspace/openers'
import {
  changedPaths,
  closeTab,
  createTab,
  diffModeLabel,
  errorCodeOf,
  errorMessage,
  failedTab,
  mergeRead,
  tabKeyOf,
  upsertTab,
  watchPaths,
  type Tab,
} from './filesModel'

const fileReq = (path = '/repo/src/a.ts', targetId = 'local'): OpenRequest => ({
  kind: 'file',
  targetId,
  path,
  line: 12,
})

const diffReq = (mode: 'worktree' | 'staged' | 'commit' | 'text' = 'worktree'): OpenRequest => ({
  kind: 'diff',
  targetId: 'local',
  path: '/repo/src/a.ts',
  cwd: '/repo',
  mode,
  ...(mode === 'commit' ? { commit: 'abcdef1234567890' } : {}),
  ...(mode === 'text' ? { diff: '@@ -1 +1 @@\n-a\n+b' } : {}),
})

const readResult = (overrides: Partial<FsReadResult> = {}): FsReadResult => ({
  path: '/repo/src/a.ts',
  content: 'hello\n',
  encoding: 'utf8',
  size: 10,
  mtimeMs: 123,
  offset: 0,
  length: 6,
  truncated: true,
  binary: false,
  ...overrides,
})

describe('标签工厂与去重', () => {
  it('文件标签带行号、父目录 cwd；text 差异直接就绪', () => {
    const file = createTab(fileReq(), 'f1')
    expect(file).toMatchObject({ id: 'f1', kind: 'file', title: 'a.ts', cwd: '/repo/src', line: 12, status: 'loading' })
    const text = createTab(diffReq('text'), 'f2')
    expect(text).toMatchObject({ status: 'ready', mode: 'text', diff: '@@ -1 +1 @@\n-a\n+b' })
    expect(text.title).toContain('本轮改动')
  })

  it('差异标签标题带模式/短 hash', () => {
    expect(diffModeLabel('worktree')).toBe('与 HEAD 对比')
    expect(diffModeLabel('staged')).toBe('暂存区对比')
    expect(diffModeLabel('commit', 'abcdef1234567890')).toBe('提交 abcdef1')
    expect(createTab(diffReq('commit'), 'f3').title).toContain('abcdef1')
  })

  it('同 targetId+path+kind 复用；差异再区分 mode/commit', () => {
    expect(tabKeyOf(createTab(fileReq(), 'f1'))).toBe(tabKeyOf(createTab(fileReq(), 'f2')))
    expect(tabKeyOf(createTab(fileReq('/repo/src/a.ts', 'ssh-1'), 'f3'))).not.toBe(tabKeyOf(createTab(fileReq(), 'f1')))
    expect(tabKeyOf(createTab(diffReq(), 'd1'))).toBe(tabKeyOf(createTab(diffReq(), 'd2')))
    expect(tabKeyOf(createTab(diffReq('staged'), 'd3'))).not.toBe(tabKeyOf(createTab(diffReq(), 'd1')))
    expect(tabKeyOf(createTab(diffReq('commit'), 'd4'))).not.toBe(tabKeyOf(createTab(diffReq(), 'd1')))
    expect(tabKeyOf(createTab(fileReq(), 'f9'))).not.toBe(tabKeyOf(createTab(diffReq(), 'd9')))
  })

  it('复用时更新行号、保留内容与状态', () => {
    const existing: Tab = {
      ...createTab(fileReq('/repo/src/a.ts', 'local'), 'f1'),
      status: 'ready',
      content: 'kept',
      line: 3,
    }
    const result = upsertTab([existing], createTab({ ...fileReq(), line: 42, column: 5 } as OpenRequest, 'f2'))
    expect(result).toMatchObject({ id: 'f1', created: false, retry: false })
    expect(result.tabs[0]).toMatchObject({ content: 'kept', status: 'ready', line: 42, column: 5 })
  })

  it('复用错误态标签时要求重试；新标签要求读取', () => {
    const broken: Tab = { ...createTab(fileReq(), 'f1'), status: 'error', error: '文件不存在' }
    const result = upsertTab([broken], createTab(fileReq(), 'f2'))
    expect(result).toMatchObject({ id: 'f1', created: false, retry: true })
    expect(result.tabs[0]).toMatchObject({ status: 'loading', revision: 2, error: undefined })
    expect(upsertTab([], createTab(fileReq(), 'f3')).created).toBe(true)
  })

  it('关闭标签后把 activeId 挪到相邻标签', () => {
    const tabs = ['f1', 'f2', 'f3'].map((id) => createTab(fileReq(`/repo/${id}.ts`), id))
    expect(closeTab(tabs, 'f2', 'f2')).toMatchObject({ activeId: 'f3' })
    expect(closeTab(tabs, 'f3', 'f3')).toMatchObject({ activeId: 'f2' })
    expect(closeTab(tabs, 'nope', 'f9')).toMatchObject({ activeId: 'nope' })
    const last = closeTab([tabs[0]!], 'f1', 'f1')
    expect(last).toEqual({ tabs: [], activeId: null })
  })
})

describe('读取结果合并与错误文案', () => {
  it('首读与续读分别替换/拼接，并记录已读字节', () => {
    const tab = createTab(fileReq(), 'f1')
    const first = mergeRead(tab, readResult(), false)
    expect(first).toMatchObject({ status: 'ready', content: 'hello\n', loadedBytes: 6, truncated: true, busy: false })
    const second = mergeRead(first, readResult({ content: 'world\n', offset: 6, length: 6, size: 12, truncated: false }), true)
    expect(second).toMatchObject({ content: 'hello\nworld\n', loadedBytes: 12, truncated: false })
  })

  it('错误码转中文，未知错误带原始信息并截断', () => {
    expect(errorCodeOf({ code: 'not_found' })).toBe('not_found')
    expect(errorCodeOf(new Error('x'))).toBe('')
    expect(errorMessage({ code: 'not_found' })).toBe('文件不存在')
    expect(errorMessage({ code: 'git_missing' })).toBe('目标机器上未安装 git')
    expect(errorMessage({ code: 'not_repo' })).toBe('当前目录不是 Git 仓库')
    expect(errorMessage({ code: 'permission' })).toBe('没有权限读取该文件')
    expect(errorMessage({ code: 'git_failed' }, '读取失败')).toBe('git 命令执行失败')
    expect(errorMessage(new Error('网络断了'), '读取文件失败')).toBe('读取文件失败：网络断了')
    expect(errorMessage(null)).toBe('操作失败')
    expect(errorMessage(new Error('x'.repeat(500)), '读取失败').length).toBeLessThan(260)
  })

  it('failedTab 保留内容并写入 errorCode', () => {
    const tab = createTab(fileReq(), 'f1')
    const failed = failedTab(tab, { code: 'not_found' }, '读取文件失败')
    expect(failed).toMatchObject({ status: 'error', error: '文件不存在', errorCode: 'not_found', busy: false })
  })
})

describe('监听路径', () => {
  it('fs.changed payload 只取字符串路径', () => {
    expect(changedPaths({ paths: ['/a.ts', 3, '', null, '/b.ts'] })).toEqual(['/a.ts', '/b.ts'])
    expect(changedPaths(null)).toEqual([])
    expect(changedPaths({})).toEqual([])
    expect(changedPaths('bad')).toEqual([])
  })

  it('getFileWatchPaths 的纯逻辑：只收集该目标已打开的文件标签并去重', () => {
    const tabs = [
      createTab(fileReq('/repo/a.ts', 'local'), 'f1'),
      createTab(fileReq('/repo/a.ts', 'local'), 'f2'),
      createTab(fileReq('/repo/b.ts', 'ssh-1'), 'f3'),
      createTab(diffReq(), 'd1'),
    ]
    expect(watchPaths(tabs, 'local')).toEqual(['/repo/a.ts'])
    expect(watchPaths(tabs, 'ssh-1')).toEqual(['/repo/b.ts'])
    expect(watchPaths(tabs, 'none')).toEqual([])
  })
})
