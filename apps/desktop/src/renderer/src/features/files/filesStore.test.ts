import { beforeEach, expect, it, vi } from 'vitest'
import { useDock } from '../../store/dock'
import { openFile } from '../workspace/openers'
import { serverCall } from '../workspace/serverCall'
import { useFiles } from './filesStore'

vi.mock('../workspace/serverCall', () => ({
  onServerEvt: vi.fn(),
  serverCall: vi.fn(),
}))

beforeEach(() => {
  useFiles.getState().closeAll()
  useFiles.getState().setOpen(false)
  useDock.getState().setView('files')
  vi.mocked(serverCall).mockResolvedValue({
    path: '/repo/README.md', content: 'abc', length: 3, size: 3, offset: 0,
    mtimeMs: 1, encoding: 'utf8', binary: false, truncated: false,
  })
})

it('两个视图共用标签和未保存文本，文件视图不会撑开对话停靠栏', async () => {
  const location = { targetId: 'ssh', path: '/repo/README.md' }
  openFile(location)
  await vi.waitFor(() => expect(useFiles.getState().tabs[0]?.status).toBe('ready'))
  const tab = useFiles.getState().tabs[0]!
  expect(tab.view).toBe('preview')
  useFiles.getState().setView(tab.id, 'source')
  useFiles.getState().edit(tab.id, 'draft')
  useFiles.getState().activate(tab.id)
  expect(useFiles.getState().open).toBe(false)
  useDock.getState().setView('chat')
  openFile(location)
  const state = useFiles.getState()
  expect(state.open).toBe(true)
  expect(state.tabs).toHaveLength(1)
  expect(state.tabs[0]).toMatchObject({ view: 'source', content: 'draft', dirty: true })
})

it('文件视图收起后，快速打开同一文件会显示已有标签和未保存文本', async () => {
  const location = { targetId: 'ssh', path: '/repo/README.md' }
  openFile(location)
  await vi.waitFor(() => expect(useFiles.getState().tabs[0]?.status).toBe('ready'))
  const { id } = useFiles.getState().tabs[0]!
  useFiles.getState().edit(id, 'draft')
  useDock.getState().toggleView('files')
  expect(useDock.getState().view).toBeNull()
  expect(useFiles.getState().open).toBe(false)

  openFile(location)
  expect(useDock.getState().view).toBe('chat')
  expect(useFiles.getState()).toMatchObject({ activeId: id, open: true, tabs: [{ id, content: 'draft', dirty: true }] })
})

it('关闭当前项目全部标签不会一并关闭其他项目未保存的文件', async () => {
  openFile({ targetId: 'ssh', path: '/a/readme.md' })
  openFile({ targetId: 'local', path: '/b/src.ts' })
  await vi.waitFor(() => expect(useFiles.getState().tabs.every((tab) => tab.status === 'ready')).toBe(true))
  const [first, other] = useFiles.getState().tabs
  useFiles.getState().edit(first!.id, 'first')
  useFiles.getState().edit(other!.id, 'other')
  useFiles.getState().requestCloseAll([first!.id])
  expect(useFiles.getState().prompt).toEqual({ kind: 'close', ids: [first!.id] })
  useFiles.getState().confirmClose(false)
  expect(useFiles.getState().tabs.map((tab) => [tab.id, tab.content, tab.dirty])).toEqual([[other!.id, 'other', true]])
})

it('关闭最后一个标签时收起文件面板，重新打开文件时展开', () => {
  useDock.getState().setView('chat')
  const firstFile = { targetId: 'ssh', path: '/repo/first.ts' }
  openFile(firstFile)
  openFile({ targetId: 'ssh', path: '/repo/second.ts' })
  const [first, second] = useFiles.getState().tabs

  useFiles.getState().requestClose(second!.id)
  expect(useFiles.getState()).toMatchObject({ open: true, activeId: first!.id })
  useFiles.getState().requestClose(first!.id)
  expect(useFiles.getState()).toMatchObject({ open: false, activeId: null, tabs: [] })

  openFile(firstFile)
  expect(useFiles.getState().open).toBe(true)
})

it('最后一个标签关闭后，旧的激活或展开操作无法重新撑开文件面板', () => {
  useDock.getState().setView('chat')
  openFile({ targetId: 'ssh', path: '/repo/README.md' })
  const { activeId, requestCloseAll, activate, setOpen } = useFiles.getState()
  expect(activeId).not.toBeNull()

  requestCloseAll()
  activate(activeId!)
  expect(useFiles.getState()).toMatchObject({ open: false, activeId: null })

  setOpen(true)
  expect(useFiles.getState()).toMatchObject({ open: false, tabs: [] })
})

it('有未保存改动时，确认关闭最后一个标签后才收起文件面板', async () => {
  useDock.getState().setView('chat')
  openFile({ targetId: 'ssh', path: '/repo/README.md' })
  await vi.waitFor(() => expect(useFiles.getState().tabs[0]?.status).toBe('ready'))
  const id = useFiles.getState().tabs[0]!.id
  useFiles.getState().edit(id, 'draft')

  useFiles.getState().requestClose(id)
  expect(useFiles.getState()).toMatchObject({ open: true, prompt: { kind: 'close', ids: [id] } })
  useFiles.getState().dismissPrompt()
  expect(useFiles.getState().open).toBe(true)

  useFiles.getState().requestClose(id)
  useFiles.getState().confirmClose(false)
  expect(useFiles.getState()).toMatchObject({ open: false, activeId: null, tabs: [], prompt: null })
})
