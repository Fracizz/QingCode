import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matchTerminalFileHits, terminalFileSearchName } from './terminalFileLinks'
import { openTerminalFile } from './terminalLinkActions'
import { getFileStat } from '../fileIpc'
import { searchFiles } from '../searchFiles'
import { authorizeExistingFile, authorizeRemoteOutsideFile } from '../pathAllowlist'
import { confirmDialog } from '../../store/confirmStore'

const { openFile, openPalette, pushToast, workspace } = vi.hoisted(() => ({
  openFile: vi.fn(),
  openPalette: vi.fn(),
  pushToast: vi.fn(),
  workspace: { root: 'D:\\code\\app' },
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('../fileIpc', () => ({ getFileStat: vi.fn() }))
vi.mock('../searchFiles', () => ({ searchFiles: vi.fn() }))
vi.mock('../pathAllowlist', () => ({
  authorizeExistingFile: vi.fn(async () => false),
  authorizeRemoteOutsideFile: vi.fn(async () => false),
}))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(async () => 'C:\\Users\\me'),
  tempDir: vi.fn(async () => 'C:\\Users\\me\\AppData\\Local\\Temp\\'),
  dataDir: vi.fn(async () => 'C:\\Users\\me\\AppData\\Roaming'),
  localDataDir: vi.fn(async () => 'C:\\Users\\me\\AppData\\Local'),
}))
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
      projects: [{ id: 'p1', name: 'app', path: workspace.root }],
      currentProject: null,
      pushToast,
    }),
  },
}))
vi.mock('../../store/terminalStore', () => ({
  useTerminalStore: { getState: () => ({ terminals: [{ id: 't1', projectId: 'p1', cwd: workspace.root }] }) },
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

describe('openTerminalFile outside the project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getFileStat).mockRejectedValue(new Error('not allowed'))
    vi.mocked(authorizeExistingFile).mockResolvedValue(false)
  })

  it('expands %TEMP% and authorizes the existing file before opening it', async () => {
    vi.mocked(authorizeExistingFile).mockResolvedValue(true)
    await openTerminalFile('t1', { path: '%TEMP%\\emop_report.html' })
    const expected = 'C:\\Users\\me\\AppData\\Local\\Temp\\emop_report.html'
    expect(authorizeExistingFile).toHaveBeenCalledWith(expected)
    expect(openFile).toHaveBeenCalledWith(expected, undefined, undefined)
    expect(searchFiles).not.toHaveBeenCalled()
  })

  it('opens Git Bash drive paths as local Windows files', async () => {
    vi.mocked(authorizeExistingFile).mockResolvedValue(true)
    await openTerminalFile('t1', { path: '/c/Users/me/bin/sshctl.exe' })
    expect(openFile).toHaveBeenCalledWith('C:\\Users\\me\\bin\\sshctl.exe', undefined, undefined)
  })

  it('never authorizes paths inside the project root', async () => {
    found([])
    await openTerminalFile('t1', { path: 'missing.py' })
    expect(authorizeExistingFile).not.toHaveBeenCalled()
  })

  it('reports a missing outside file with the original spelling', async () => {
    await openTerminalFile('t1', { path: '%TEMP%\\gone.html' })
    expect(openFile).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('error', '未找到文件：%TEMP%\\gone.html')
  })

  it('asks before authorizing a hidden OSC 8 target outside the project', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false)
    await openTerminalFile('t1', { path: 'C:\\Users\\me\\a.txt' }, { confirmOutsideProject: true })
    expect(confirmDialog).toHaveBeenCalledOnce()
    expect(authorizeExistingFile).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })
})

describe('openTerminalFile in an SSH project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspace.root = 'ssh://conn-1/D:/code/app'
    vi.mocked(getFileStat).mockRejectedValue(new Error('missing'))
  })
  afterEach(() => {
    workspace.root = 'D:\\code\\app'
  })

  it('authorizes a remote file outside the root read-only and opens it', async () => {
    vi.mocked(authorizeRemoteOutsideFile).mockResolvedValue(true)
    await openTerminalFile('t1', { path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\sheet2.png' })
    const expected = 'ssh://conn-1/C:/Users/Administrator/AppData/Local/Temp/sheet2.png'
    expect(authorizeRemoteOutsideFile).toHaveBeenCalledWith(expected)
    expect(authorizeExistingFile).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledWith(expected, undefined, undefined)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('reports a missing remote file outside the root', async () => {
    vi.mocked(authorizeRemoteOutsideFile).mockResolvedValue(false)
    await openTerminalFile('t1', { path: 'C:\\Users\\Administrator\\gone.png' })
    expect(openFile).not.toHaveBeenCalled()
    expect(searchFiles).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('error', '未找到文件：C:\\Users\\Administrator\\gone.png')
  })

  it('asks before authorizing a hidden OSC 8 remote target outside the root', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false)
    await openTerminalFile('t1', { path: 'C:\\Users\\me\\a.txt' }, { confirmOutsideProject: true })
    expect(confirmDialog).toHaveBeenCalledOnce()
    expect(authorizeRemoteOutsideFile).not.toHaveBeenCalled()
  })

  it('explains that remote path variables cannot be expanded locally', async () => {
    await openTerminalFile('t1', { path: '~/.claude/settings.json' })
    expect(authorizeRemoteOutsideFile).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('error', '无法在本机展开远程终端的路径变量：~/.claude/settings.json')
  })

  it('still reports a missing file inside the remote project root', async () => {
    await openTerminalFile('t1', { path: 'D:\\code\\app\\gone.py' })
    expect(getFileStat).toHaveBeenCalledWith({ path: 'ssh://conn-1/D:/code/app/gone.py' })
    expect(pushToast).toHaveBeenCalledWith('error', '未找到文件：D:\\code\\app\\gone.py')
  })
})
