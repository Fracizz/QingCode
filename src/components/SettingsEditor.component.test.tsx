// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsEditor from './SettingsEditor'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS } from '../lib/shortcuts'

// SettingsLayout uses IntersectionObserver for scroll-spy; jsdom does not ship it.
beforeAll(() => {
  if (typeof IntersectionObserver === 'undefined') {
    class IntersectionObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
    ;(globalThis as unknown as { IntersectionObserver: typeof IntersectionObserverStub }).IntersectionObserver =
      IntersectionObserverStub
  }
})

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
  DEFAULT_FONT_SETTINGS: { interfaceFont: 'sans', monoFont: 'mono', interfaceFontSize: 13, monoFontSize: 13 },
  FONT_SETTINGS_EVENT: 'qingcode:font-settings-changed',
  FONT_SIZE_OPTIONS: [],
  INTERFACE_FONT_OPTIONS: [],
  MONO_FONT_OPTIONS: [],
  loadFontSettings: () => ({ interfaceFont: 'sans', monoFont: 'mono', interfaceFontSize: 13, monoFontSize: 13 }),
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
    useProjectStore.setState(initialProjectState, true)
    useEditorStore.setState(initialEditorState, true)
    useUIStore.setState(initialUiState, true)
    useShortcutStore.setState(initialShortcutState, true)
  })

  it('renders the settings category navigation', () => {
    render(<SettingsEditor />)
    expect(screen.getByRole('button', { name: '常用设置' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '文本编辑器' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '终端' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开设置 JSON' })).toBeInTheDocument()
  })

  it('restores user defaults after confirming the scope and preserves project records', async () => {
    mocks.tauri = true
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '恢复默认设置' }))
    await waitFor(() => expect(mocks.resetSettings).toHaveBeenCalledWith('global', null))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('保留项目列表'), kind: 'warning',
    }))
  })

  it('cancelling restoration does not write settings', async () => {
    mocks.tauri = true
    mocks.confirm.mockResolvedValue(false)
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '恢复默认设置' }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.resetSettings).not.toHaveBeenCalled()
  })

  it('restores only the selected workspace', async () => {
    mocks.tauri = true
    const project = { id: 'w', name: 'Workspace', path: 'D:/workspace', created_at: 1, last_opened_at: 1 }
    useProjectStore.setState({ currentProject: project })
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复默认设置' }))
    await waitFor(() => expect(mocks.resetSettings).toHaveBeenCalledWith('project', project))
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Workspace') }))
  })

  it('exports user settings through the save dialog', async () => {
    mocks.tauri = true
    mocks.exportSettings.mockResolvedValue({ format: 'qingcode-settings', scope: 'global', settings: {} })
    mocks.saveDialog.mockResolvedValue('D:/backup.json')
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '导出配置 JSON' }))
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
    fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '导入配置 JSON' }))
    await waitFor(() => expect(mocks.importSettings).toHaveBeenCalledWith('{"editor.tabSize":2}', 'project', project))
    expect(useProjectStore.getState().pushToast).toHaveBeenCalledWith('info', '配置已导入，1 个项目路径不可用', 'D:/missing')
  })

  it('cancelling the import dialog leaves settings untouched', async () => {
    mocks.tauri = true
    mocks.openDialog.mockResolvedValue(null)
    render(<SettingsEditor />)
    fireEvent.click(screen.getByRole('button', { name: '导入配置 JSON' }))
    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalled())
    expect(mocks.importSettings).not.toHaveBeenCalled()
  })

  it('persists the minimap toggle through saveScopedMinimapEnabled', async () => {
    render(<SettingsEditor />)
    // Default scope is 'user' → settings scope 'global'; project is null but
    // the global branch does not require a project.
    const minimapSelect = screen.getByLabelText('编辑器: 小地图') as HTMLSelectElement
    fireEvent.change(minimapSelect, { target: { value: 'off' } })

    await waitFor(() =>
      expect(mocks.saveScopedMinimapEnabled).toHaveBeenCalledWith('global', false, null)
    )
  })
  it('offers automatic and custom project-session LRU settings', async () => {
    render(<SettingsEditor />)
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
})
