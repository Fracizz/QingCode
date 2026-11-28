import { beforeEach, expect, it, vi } from 'vitest'
import { call } from '../../lib/backend'
import { explorerScopeKey, useExplorer } from './explorerStore'
import { visibleRows } from './treeModel'

vi.mock('../../lib/backend', () => ({ call: vi.fn() }))
vi.mock('../workspace/serverCall', () => ({ onServerEvt: vi.fn(), serverCall: vi.fn() }))

const list = vi.mocked(call)
const { actions } = useExplorer.getState()

beforeEach(() => {
  list.mockReset()
  useExplorer.setState({ scopes: {}, watchRevision: 0 })
})

it('从项目根懒加载并展开当前文件的父目录，保留 Windows 的真实名称', async () => {
  const root = 'D:\\Work\\Repo'
  const subdir = `${root}\\Src`
  const nested = `${subdir}\\Some Folder`
  list.mockResolvedValueOnce({ entries: [{ name: 'Src', kind: 'dir' }] })
    .mockResolvedValueOnce({ entries: [{ name: 'Some Folder', kind: 'dir' }] })
    .mockResolvedValueOnce({ entries: [{ name: 'README.md', kind: 'file' }] })
  actions.init('ssh', root)

  const result = await actions.locateFile('ssh', root, 'd:/work/repo/src/some folder/readme.md')
  const path = `${nested}\\README.md`
  expect(result).toEqual({ path })
  expect(list.mock.calls.map(([, args]) => (args as { params: { path: string } }).params.path))
    .toEqual([root, subdir, nested])
  const tree = useExplorer.getState().scopes[explorerScopeKey('ssh', root)]!.tree
  expect(tree.expanded).toEqual([subdir, nested])
  expect(visibleRows(tree, root).at(-1)?.path).toBe(path)
})

it('等待最新的目录刷新结果，保留隐藏文件过滤，并可再次定位', async () => {
  let finishFirst!: (value: unknown) => void
  let finishLatest!: (value: unknown) => void
  list.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishLatest = resolve }))
  actions.init('local', '/repo')
  const locate = actions.locateFile('local', '/repo', '/repo/.env')
  const reload = actions.refresh('local', '/repo')
  await Promise.resolve()
  finishFirst({ entries: [] })
  finishLatest({ entries: [{ name: '.env', kind: 'file' }] })

  expect(await locate).toEqual({ error: '请先显示隐藏文件再定位' })
  await reload
  actions.setHidden('local', '/repo', true)
  expect(await actions.locateFile('local', '/repo', '/repo/.env')).toEqual({ path: '/repo/.env' })
  expect(await actions.locateFile('local', '/repo', '/repo/../other/file')).toEqual({ error: '文件不在当前项目内' })
  expect(list).toHaveBeenCalledTimes(2)
})
