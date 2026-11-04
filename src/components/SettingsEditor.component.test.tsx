// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsEditor from './SettingsEditor'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS } from '../lib/shortcuts'

// Spies we assert on must live in vi.hoisted so the vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
  tauri: false,
  invoke: vi.fn(),
  exportSettings: vi.fn(),
  importSettings: vi.fn(),
  resetSettings: vi.fn(),
  confirm: vi.fn(),
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  saveScopedMinimapEnabled: vi.fn(),
  saveScopedEditorGuidesEnabled: vi.fn(),
  saveTheme: vi.fn(),
  saveFontSettings: vi.fn(),
  saveTerminalProfileSettings: vi.fn(),
  saveEditorStateCacheSize: vi.fn(),
  saveGitRefreshIntervalStartMinutes: vi.fn(),
}))

vi.mock('../lib/settingsTransfer', () => ({
  exportSettings: mocks.exportSettings,
  importSettings: mocks.importSettings,
  resetSettings: mocks.resetSettings,
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog: mocks.confirm }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog, save: mocks.saveDialog }))

vi.mock('../lib/tauri', () => ({
  isTauri: () => mocks.tauri,
  safeInvoke: mocks.invoke,
  NotInTauriError: class NotInTauriError extends Error {
    constructor(action: string) {
      super(`Not in Tauri: ${action}`)
      this.name = 'NotInTauriError'
    }
  },
}))

vi.mock('../lib/minimapSettings', () => ({
  MINIMAP_SETTINGS_EVENT: 'qingcode:minimap-settings-changed',
  getMinimapEnabled: () => true,
  loadScopedMinimapEnabled: async () => true,
  saveScopedMinimapEnabled: mocks.saveScopedMinimapEnabled,
}))

vi.mock('../lib/editorSettings', () => ({
  loadScopedEditorGuidesEnabled: async () => true,
  saveScopedEditorGuidesEnabled: mocks.saveScopedEditorGuidesEnabled,
}))

vi.mock('../lib/updateSettings', () => ({
  DEFAULT_UPDATE_SETTINGS: { checkOnStartup: true },
  loadUpdateSettings: async () => ({ checkOnStartup: true }),
  saveCheckOnStartup: vi.fn(),
}))

vi.mock('../lib/sessionPersistSettings', () => ({
  DEFAULT_SESSION_PERSIST: false,
  loadSessionPersistEnabled: async () => false,
  saveSessionPersistEnabled: vi.fn(),
}))

vi.mock('../lib/editorStateCacheSettings', () => ({
  DEFAULT_EDITOR_STATE_CACHE_SIZE: 12,
  MIN_EDITOR_STATE_CACHE_SIZE: 1,
  MAX_EDITOR_STATE_CACHE_SIZE: 100,
  loadEditorStateCacheSize: async () => 'auto',
  saveEditorStateCacheSize: mocks.saveEditorStateCacheSize,
}))

vi.mock('../lib/gitRefreshSettings', () => ({
  DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES: 5,
  MIN_GIT_REFRESH_INTERVAL_START_MINUTES: 5,
  MAX_GIT_REFRESH_INTERVAL_START_MINUTES: 1440,
  loadGitRefreshIntervalStartMinutes: async () => 5,
  parseGitRefreshIntervalStartMinutes: (value: unknown) => {
    const parsed = Number(value)
    return Math.min(1440, Math.max(5, Number.isFinite(parsed) ? Math.round(parsed) : 5))
  },
  saveGitRefreshIntervalStartMinutes: mocks.saveGitRefreshIntervalStartMinutes,
}))

vi.mock('../lib/autoSaveSettings', () => ({
  AUTO_SAVE_MODES: [{ value: 'off', label: '关闭' }],
  AUTO_SAVE_DELAY_OPTIONS: [],
  loadScopedAutoSaveSettings: async () => ({ mode: 'off', delay: 1000 }),
  saveScopedAutoSaveSettings: vi.fn(),
}))

vi.mock('../lib/openWithSettings', () => ({
  getOpenWithStatus: async () => null,
  registerOpenWith: vi.fn(),
  unregisterOpenWith: vi.fn(),
}))

vi.mock('../lib/appUpdate', () => ({
  checkForAppUpdate: vi.fn(),
  promptAppUpdate: vi.fn(),
}))

vi.mock('../lib/qingcodeCliSkill', () => ({
  buildQingcodeCliSkillMarkdown: () => '',
}))

vi.mock('../utils/fileReferences', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('../lib/projectSettings', () => ({
  ensureSettingsFile: vi.fn().mockResolvedValue(undefined),
  loadGlobalSettings: vi.fn().mockResolvedValue({}),
  loadProjectSettings: vi.fn().mockResolvedValue({}),
  resolveGlobalSettingsPath: async () => 'D:/settings.json',
  resolveProjectSettingsPath: async () => 'D:/proj-settings.json',
  DEFAULT_GLOBAL_SETTINGS: {
    'files.autoSaveDelay': 1000,
    'files.autoSave': 'off',
    'editor.minimap.enabled': true,
    'editor.guides.enabled': true,
  },
}))

vi.mock('../lib/themeSettings', () => ({
  DEFAULT_THEME: 'olive',
  THEMES: [{ id: 'olive', label: '橄榄绿' }],
  loadTheme: () => 'olive',
  saveTheme: mocks.saveTheme,
}))

vi.mock('../lib/fontSettings', () => ({
  DEFAULT_FONT_SETTINGS: { interfaceFont: 'sans', monoFont: 'mono', terminalFont: 'terminal-mono', interfaceFontSize: 13, editorFontSize: 14, terminalFontSize: 13 },
  FONT_SETTINGS_EVENT: 'qingcode:font-settings-changed',
  FONT_SIZE_OPTIONS: [],
  INTERFACE_FONT_OPTIONS: [],
  MONO_FONT_OPTIONS: [],
  TERMINAL_FONT_OPTIONS: [
    { label: '系统默认', value: 'terminal-mono' },
    { label: 'Consolas', value: 'Consolas, monospace' },
  ],
  loadFontSettings: () => ({ interfaceFont: 'sans', monoFont: 'mono', terminalFont: 'terminal-mono', interfaceFontSize: 13, editorFontSize: 14, terminalFontSize: 13 }),
  saveFontSettings: mocks.saveFontSettings,
  loadSystemFontFamilies: async () => [],
  systemFontOptions: () => [],
  withCurrentFontOption: (options: unknown[]) => options,
}))

vi.mock('../lib/terminalProfiles', () => ({
  DEFAULT_TERMINAL_PROFILE: { defaultShell: null, profiles: [] },
  loadTerminalProfileSettings: () => ({ defaultShell: null, profiles: [] }),
  saveTerminalProfileSettings: mocks.saveTerminalProfileSettings,
}))

vi.mock('../lib/terminalShell', () => ({
  availableTerminalShells: () => [],
  defaultTerminalShell: () => null,
  terminalShellLabelKey: () => 'x',
}))

const initialProjectState = useProjectStore.getState()
const initialEditorState = useEditorStore.getState()
const initialUiState = useUIStore.getState()
const initialShortcutState = useShortcutStore.getState()

describe('SettingsEditor', () => {
  beforeEach(() => {
    mocks.tauri = false
    mocks.invoke.mockReset()
    mocks.openDialog.mockReset()
    mocks.saveDialog.mockReset()
    mocks.exportSettings.mockReset()
    mocks.importSettings.mockReset()
    mocks.resetSettings.mockReset().mockResolvedValue({ scope: 'global' })
    mocks.confirm.mockReset().mockResolvedValue(true)
    mocks.saveScopedMinimapEnabled.mockReset()
    mocks.saveScopedEditorGuidesEnabled.mockReset()
    mocks.saveTheme.mockReset()
    mocks.saveFontSettings.mockReset()
    mocks.saveTerminalProfileSettings.mockReset()
    mocks.saveEditorStateCacheSize.mockReset().mockResolvedValue('auto')
    mocks.saveGitRefreshIntervalStartMinutes.mockReset().mockResolvedValue(5)
    useProjectStore.setState({ currentProject: null, pushToast: vi.fn() })
    useEditorStore.setState({ openFile: vi.fn() })
    useUIStore.setState({ setView: vi.fn(), settingsFocusQuery: '', settingsFocusSignal: 0 })
    useShortcutStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useProjectStore.setState(initialProjectState, true)
    useEditorStore.setState(initialEditorState, true)
    useUIStore.setState(initialUiState, true)
    useShortcutStore.setState(initialShortcutState, true)
  })

  it('shows one category at a time and opens mobile settings independently', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
    render(<SettingsEditor />)
    for (const name of ['外观与语言', '编辑器与文件', '终端', '项目与会话', '远程连接', '移动连接', '工具与集成', '快捷键', '更新与关于']) {
      expect(screen.getByRole('button', { name, exact: true })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: '打开设置 JSON' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(screen.getByRole('region', { name: '外观与语言' })).toHaveTextContent('界面字体')
    expect(screen.queryByLabelText('编辑器: 小地图')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移动连接', exact: true }))
    expect(screen.getByRole('region', { name: '移动连接' })).toHaveTextContent('Android 移动连接')
    expect(screen.getAllByRole('region')).toHaveLength(1)
    fireEvent.change(screen.getByPlaceholderText('搜索设置'), { target: { value: 'Android' } })
    expect(screen.getByText('Android 移动连接')).toBeInTheDocument()
  })

  it('saves an independent terminal font and restores the terminal system default', () => {
    render(<SettingsEditor />)
    fireEvent.change(screen.getByPlaceholderText('搜索设置'), { target: { value: '终端字体' } })
    const font = screen.getByLabelText('终端 › 集成: 字体族')
    expect(font).toHaveValue('terminal-mono')
    expect(screen.queryByRole('option', { name: '跟随编辑器字体' })).not.toBeInTheDocument()
    fireEvent.change(font, { target: { value: 'Consolas, monospace' } })
    expect(mocks.saveFontSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      terminalFont: 'Consolas, monospace', monoFont: 'mono', terminalFontSize: 13,
    }))
    fireEvent.change(font, { target: { value: 'terminal-mono' } })
    expect(mocks.saveFontSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      terminalFont: 'terminal-mono', monoFont: 'mono',
    }))
  })

  it('hides user-only terminal controls in project scope', () => {
    useProjectStore.setState({ currentProject: {
      id: 'w', name: 'Workspace', path: 'D:/workspace', created_at: 1, last_opened_at: 1,
    } })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('tab', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('button', { name: '终端', exact: true }))
    expect(screen.queryByLabelText('终端 › 集成: 字体族')).not.toBeInTheDocument()
    expect(screen.getByLabelText('终端 › 集成: SSH 粘贴上传')).toBeInTheDocument()
  })

  it('restores user defaults after confirming the scope and preserves project records', async () => {
    mocks.tauri = true
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复默认设置' }))
    await waitFor(() => expect(mocks.resetSettings).toHaveBeenCalledWith('global', null))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('保留项目列表'), kind: 'warning',
    }))
  })

  it('cancelling restoration does not write settings', async () => {
    mocks.tauri = true
    mocks.confirm.mockResolvedValue(false)
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复默认设置' }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.resetSettings).not.toHaveBeenCalled()
  })

  it('restores only the selected workspace', async () => {
    mocks.tauri = true
    const project = { id: 'w', name: 'Workspace', path: 'D:/workspace', created_at: 1, last_opened_at: 1 }
    useProjectStore.setState({ currentProject: project })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('tab', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复默认设置' }))
    await waitFor(() => expect(mocks.resetSettings).toHaveBeenCalledWith('project', project))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Workspace') }))
  })

  it('exports user settings through the save dialog', async () => {
    mocks.tauri = true
    mocks.exportSettings.mockResolvedValue({ format: 'qingcode-settings', scope: 'global', settings: {} })
    mocks.saveDialog.mockResolvedValue('D:/backup.json')
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导出配置 JSON' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('导出配置', 'write_file', {
      path: 'D:/backup.json', content: expect.stringContaining('qingcode-settings'),
    }))
    expect(mocks.exportSettings).toHaveBeenCalledWith('global', null)
  })

  it('imports into the selected workspace and reports unavailable project paths', async () => {
    mocks.tauri = true
    const project = { id: 'w', name: 'Workspace', path: 'D:/workspace', created_at: 1, last_opened_at: 1 }
    useProjectStore.setState({ currentProject: project })
    mocks.openDialog.mockResolvedValue('D:/import.json')
    mocks.invoke.mockResolvedValue('{"editor.tabSize":2}')
    mocks.importSettings.mockResolvedValue({ skippedProjects: ['D:/missing'] })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('tab', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导入配置 JSON' }))
    await waitFor(() => expect(mocks.importSettings).toHaveBeenCalledWith('{"editor.tabSize":2}', 'project', project))
    expect(useProjectStore.getState().pushToast).toHaveBeenCalledWith('info', '配置已导入，1 个项目路径不可用', 'D:/missing')
  })

  it('opens settings JSON from management in the selected scope', async () => {
    mocks.tauri = true
    useProjectStore.setState({ currentProject: { id: 'p', name: 'Demo', path: '/demo', created_at: 1, last_opened_at: 1 } })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '打开设置 JSON' }))
    await waitFor(() => expect(useEditorStore.getState().openFile).toHaveBeenCalledWith('D:/settings.json'))
    fireEvent.click(screen.getByRole('tab', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '打开设置 JSON' }))
    await waitFor(() => expect(useEditorStore.getState().openFile).toHaveBeenCalledWith('D:/proj-settings.json'))
  })

  it('searches across categories, filters rows, and returns to a selected category', () => {
    render(<SettingsEditor />)
    fireEvent.change(screen.getByPlaceholderText('搜索设置'), { target: { value: '字体' } })
    expect(screen.getByRole('region', { name: '外观与语言' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '编辑器与文件' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '终端' })).toBeInTheDocument()
    expect(screen.queryByLabelText('编辑器: 小地图')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('终端 › 集成: SSH 粘贴上传')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '终端', exact: true }))
    expect(screen.getByPlaceholderText('搜索设置')).toHaveValue('')
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(screen.getByLabelText('终端 › 集成: SSH 粘贴上传')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('搜索设置'), { target: { value: 'Ctrl+Shift+G' } })
    expect(screen.getByLabelText('切换小地图')).toBeInTheDocument()
    expect(screen.queryByLabelText('打开命令面板')).not.toBeInTheDocument()
  })

  it('restores a hidden category after returning to user scope', () => {
    useProjectStore.setState({ currentProject: { id: 'p', name: 'Demo', path: '/demo', created_at: 1, last_opened_at: 1 } })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '工具与集成' }))
    fireEvent.click(screen.getByRole('tab', { name: '当前项目' }))
    expect(screen.getByRole('region', { name: '编辑器与文件' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '用户' }))
    expect(screen.getByRole('region', { name: '工具与集成' })).toBeInTheDocument()
  })

  it('keeps terminal configuration deep links working', async () => {
    useUIStore.setState({ settingsFocusQuery: '终端配置', settingsFocusSignal: 12345 })
    render(<SettingsEditor />)
    await waitFor(() => expect(screen.getByPlaceholderText('搜索设置')).toHaveValue('终端配置'))
    expect(screen.getByRole('region', { name: '终端' })).toBeInTheDocument()
    expect(screen.getByLabelText('终端配置')).toBeInTheDocument()
  })

  it('cancelling the import dialog leaves settings untouched', async () => {
    mocks.tauri = true
    mocks.openDialog.mockResolvedValue(null)
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '管理设置' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导入配置 JSON' }))
    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalled())
    expect(mocks.importSettings).not.toHaveBeenCalled()
  })

  it('persists the minimap toggle through saveScopedMinimapEnabled', async () => {
    render(<SettingsEditor />)
    // Default scope is 'user' → settings scope 'global'; project is null but
    // the global branch does not require a project.
    fireEvent.click(screen.getByRole('button', { name: '编辑器与文件' }))
    const minimapSelect = screen.getByLabelText('编辑器: 小地图') as HTMLSelectElement
    fireEvent.change(minimapSelect, { target: { value: 'off' } })

    await waitFor(() =>
      expect(mocks.saveScopedMinimapEnabled).toHaveBeenCalledWith('global', false, null)
    )
  })
  it('offers automatic and custom project-session LRU settings', async () => {
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '项目与会话' }))
    const mode = screen.getByLabelText('项目会话 LRU 个数') as HTMLSelectElement
    await waitFor(() => expect(mode).toBeEnabled())
    expect(mode.value).toBe('auto')

    fireEvent.change(mode, { target: { value: 'custom' } })
    await waitFor(() => expect(mocks.saveEditorStateCacheSize).toHaveBeenCalledWith(12))

    const count = screen.getByLabelText('项目会话 LRU 自定义个数')
    fireEvent.change(count, { target: { value: '24' } })
    fireEvent.blur(count)
    await waitFor(() => expect(mocks.saveEditorStateCacheSize).toHaveBeenCalledWith(24))
  })

  it('defaults randomized Git polling to a 5-minute start and saves whole minutes', async () => {
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '项目与会话' }))
    const interval = screen.getByLabelText(
      'Git 随机刷新周期起始值（分钟）',
    ) as HTMLInputElement
    await waitFor(() => expect(interval.value).toBe('5'))
    expect(interval.min).toBe('5')
    expect(interval.step).toBe('1')

    fireEvent.change(interval, { target: { value: '9' } })
    fireEvent.blur(interval)
    await waitFor(() =>
      expect(mocks.saveGitRefreshIntervalStartMinutes).toHaveBeenCalledWith(9),
    )
  })
  it('finds configuration keys and clears an empty search back into the focused input', () => {
    render(<SettingsEditor />)
    expect(screen.queryByRole('button', { name: '移动连接', exact: true })).toBeNull()
    const search = screen.getByPlaceholderText('搜索设置')
    fireEvent.change(search, { target: { value: 'editor.minimap.enabled' } })
    expect(screen.getByLabelText('编辑器: 小地图')).toBeVisible()
    expect(screen.getByRole('button', { name: '编辑器与文件' })).toBeVisible()
    fireEvent.change(search, { target: { value: 'no-such-setting' } })
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的设置')
    fireEvent.click(screen.getAllByRole('button', { name: '清除搜索' })[0])
    expect(search).toHaveFocus()
    expect(screen.getByRole('region', { name: '外观与语言' })).toBeVisible()
  })

  it('keeps the project scope navigation consistent with the rendered sections', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
    useProjectStore.setState({ currentProject: { id: 'p', name: 'Demo', path: '/demo', created_at: 1, last_opened_at: 1 } })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('tab', { name: '当前项目' }))
    expect(screen.queryByRole('button', { name: '工具与集成', exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '更新与关于', exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '移动连接', exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '外观与语言' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '项目与会话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '快捷键', exact: true })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '编辑器与文件' })).toBeInTheDocument()
    expect(screen.getByText('当前项目：Demo')).toBeVisible()
  })

})
