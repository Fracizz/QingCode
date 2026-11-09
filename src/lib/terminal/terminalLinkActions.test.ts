import { beforeEach, describe, expect, it, vi } from 'vitest'
import { matchTerminalFileHits, terminalFileSearchName } from './terminalFileLinks'
import { openTerminalFile } from './terminalLinkActions'
import { getFileStat } from '../fileIpc'
import { searchFiles } from '../searchFiles'

const { openFile, openPalette, pushToast } = vi.hoisted(() => ({
  openFile: vi.fn(),
  openPalette: vi.fn(),
  pushToast: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('../fileIpc', () => ({ getFileStat: vi.fn() }))
vi.mock('../searchFiles', () => ({ searchFiles: vi.fn() }))
vi.mock('../excludeSettings', () => ({
  loadExcludeSettingsForProject: vi.fn(async () => ({ searchExclude: [], useIgnoreFiles: true, followSymlinks: false })),
}))
vi.mock('../i18n', () => ({
  translate: (key: string, vars: Record<string, string> = {}) =>
    key.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? ''),
}))
vi.mock('../../store/confirmStore', () => ({ confirmDialog: vi.fn() }))
vi.mock('../../store/editorStore', () => ({ useEditorStore: { getState: () => ({ openFile }) } }))
vi.mock('../../store/commandPaletteStore', () => ({ useCommandPaletteStore: { getState: () => ({ openPalette }) } }))
vi.mock('../../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: 'p1', name: 'app', path: 'D:\\code\\app' }],
      currentProject: null,
      pushToast,
    }),
  },
}))
vi.mock('../../store/terminalStore', () => ({
  useTerminalStore: { getState: () => ({ terminals: [{ id: 't1', projectId: 'p1', cwd: 'D:\\code\\app' }] }) },
}))

const hit = (relative: string, is_dir = false) => ({
  name: relative.split('/').pop()!,
  path: `D:\\code\\app\\${relative.replace(/\//g, '\\')}`,
  relative,
  is_dir,
})
const found = (hits: ReturnType<typeof hit>[], truncated = false) =>
  vi.mocked(searchFiles).mockResolvedValue({ hits, truncated })

describe('terminal file name search helpers', () => {
  it('searches relative paths by file name but never absolute paths', () => {
    expect(terminalFileSearchName('model_log_faults.py')).toBe('model_log_faults.py')
    expect(terminalFileSearchName('src\\lib/a.ts')).toBe('a.ts')
    expect(terminalFileSearchName('/srv/a.ts')).toBeNull()
    expect(terminalFileSearchName('D:\\code\\a.ts')).toBeNull()
  })

  it('requires the whole file name and keeps directories out', () => {
    const hits = [hit('old_faults.py'), hit('faults.py', true), hit('pkg/faults.py')]
    expect(matchTerminalFileHits('faults.py', hits).map(item => item.relative)).toEqual(['pkg/faults.py'])
  })

  it('matches the directory part of a relative path', () => {
    const hits = [hit('a/util.ts'), hit('b/lib/util.ts')]
    expect(matchTerminalFileHits('./lib/util.ts', hits).map(item => item.relative)).toEqual(['b/lib/util.ts'])
  })

  it('prefers exact case and falls back to case-insensitive matches', () => {
    expect(matchTerminalFileHits('foo.py', [hit('Foo.py'), hit('x/foo.py')]).map(item => item.relative)).toEqual(['x/foo.py'])
    expect(matchTerminalFileHits('foo.py', [hit('Foo.py')]).map(item => item.relative)).toEqual(['Foo.py'])
  })
})

describe('openTerminalFile project search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getFileStat).mockRejectedValue(new Error('missing'))
  })

  it('opens the only file with that name, keeping the line and column', async () => {
    found([hit('scripts/model_log_faults.py')])
    await openTerminalFile('t1', { path: 'model_log_faults.py', line: 3, column: 2 })
    expect(openFile).toHaveBeenCalledWith('D:\\code\\app\\scripts\\model_log_faults.py', 3, 2)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('does not search when the direct path already exists', async () => {
    vi.mocked(getFileStat).mockResolvedValue({ is_dir: false } as Awaited<ReturnType<typeof getFileStat>>)
    await openTerminalFile('t1', { path: 'a.py' })
    expect(openFile).toHaveBeenCalledOnce()
    expect(searchFiles).not.toHaveBeenCalled()
  })

  it('lets the user choose between files with the same name', async () => {
    found([hit('a/util.py'), hit('b/util.py')])
    await openTerminalFile('t1', { path: 'util.py', line: 8 })
    expect(openPalette).toHaveBeenCalledWith('util.py:8')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not guess from a truncated result', async () => {
    found([hit('a/util.py')], true)
    await openTerminalFile('t1', { path: 'util.py' })
    expect(openFile).not.toHaveBeenCalled()
    expect(openPalette).toHaveBeenCalledWith('util.py')
  })

  it('says the whole project was searched when nothing matches', async () => {
    found([hit('old_faults.py')])
    await openTerminalFile('t1', { path: 'faults.py' })
    expect(pushToast).toHaveBeenCalledWith('error', '项目中未找到 faults.py')
  })

  it('does not claim the project lacks the file when the search fails', async () => {
    vi.mocked(searchFiles).mockRejectedValue(new Error('offline'))
    await openTerminalFile('t1', { path: 'faults.py' })
    expect(pushToast).toHaveBeenCalledWith('error', '未找到文件：faults.py')
  })

  it('keeps the plain message for absolute paths without searching', async () => {
    await openTerminalFile('t1', { path: 'D:\\other\\a.py' })
    expect(searchFiles).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('error', '未找到文件：D:\\other\\a.py')
  })

  it('drops an earlier search when a newer link is clicked', async () => {
    let finish!: (value: { hits: ReturnType<typeof hit>[]; truncated: boolean }) => void
    vi.mocked(searchFiles).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const earlier = openTerminalFile('t1', { path: 'slow.py' })
    await vi.waitFor(() => expect(finish).toBeDefined())
    found([hit('src/fast.py')])
    await openTerminalFile('t1', { path: 'fast.py' })
    finish({ hits: [hit('src/slow.py')], truncated: false })
    await earlier
    expect(openFile).toHaveBeenCalledOnce()
    expect(openFile).toHaveBeenCalledWith('D:\\code\\app\\src\\fast.py', undefined, undefined)
  })
})
