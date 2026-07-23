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
  saveScopedMinimapEnabled: vi.fn(),
  saveScopedEditorGuidesEnabled: vi.fn(),
  saveTheme: vi.fn(),
  saveFontSettings: vi.fn(),
  saveTerminalProfileSettings: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  isTauri: () => false,
  safeInvoke: vi.fn(),
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
  DEFAULT_THEME: 'forest',
  THEMES: [{ id: 'forest', label: '森林' }],
  loadTheme: () => 'forest',
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
    mocks.saveScopedMinimapEnabled.mockReset()
    mocks.saveScopedEditorGuidesEnabled.mockReset()
    mocks.saveTheme.mockReset()
    mocks.saveFontSettings.mockReset()
    mocks.saveTerminalProfileSettings.mockReset()
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
})
