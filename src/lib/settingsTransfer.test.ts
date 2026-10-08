// @vitest-environment jsdom
import JSON5 from 'json5'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseSettingsTransfer,
  patchSettingsText,
  importSettings,
  exportSettings,
  resetSettings,
} from './settingsTransfer'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { DEFAULT_THEME, loadTheme, saveTheme } from './themeSettings'
import { DEFAULT_FONT_SETTINGS, loadFontSettings, applyStoredFontSettings } from './fontSettings'
import {
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  DEFAULT_TERMINAL_PROFILE,
} from './terminal/terminalProfiles'
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS } from './shortcuts'
import { useLocaleStore, DEFAULT_LANGUAGE } from './i18n'
import { defaultSettingsFor } from './projectSettings'

const mocks = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  invoke: vi.fn(),
  importProjects: vi.fn(async () => [] as string[]),
  apply: vi.fn(async () => {}),
  projects: [] as unknown[],
}))
vi.mock('./tauri', () => ({
  isTauri: () => true,
  safeInvoke: mocks.invoke,
  NotInTauriError: class extends Error {},
}))
vi.mock('./projectRepository', () => ({
  listProjects: async () => mocks.projects,
  withDb: async (_action: string, callback: (db: unknown) => unknown) => callback({}),
  importSettingsProjects: mocks.importProjects,
}))
vi.mock('./effectiveSettings', () => ({ applyEffectiveSettings: mocks.apply }))
vi.mock('./sessionPersistSettings', () => ({
  loadSessionPersistEnabled: async () => true,
  notifySessionPersistChanged: vi.fn(),
}))
vi.mock('./projectIndicatorSettings', () => ({
  loadProjectIndicatorsEnabled: async () => true,
  notifyProjectIndicatorsChanged: vi.fn(),
}))
vi.mock('./gitRefreshSettings', () => ({ loadGitRefreshIntervalStartMinutes: async () => 5 }))

const globalPath = 'D:/app/default-settings.json'
const workspace = {
  id: 'w',
  name: 'Workspace',
  path: 'D:/workspace',
  created_at: 1,
  last_opened_at: 1,
}
const workspacePath = 'D:/workspace/.qingcode/project-settings.json'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.disk.clear()
  mocks.projects = []
  mocks.importProjects.mockResolvedValue([])
  mocks.invoke.mockImplementation(
    async (_action: string, command: string, args?: Record<string, unknown>) => {
      if (command === 'default_settings_path') return globalPath
      const path = String(args?.path)
      if (command === 'file_mtime') return mocks.disk.has(path) ? 123 : null
      if (command === 'read_file') {
        if (!mocks.disk.has(path)) throw new Error('missing')
        return mocks.disk.get(path)
      }
      if (command === 'write_file') mocks.disk.set(path, String(args?.content))
    }
  )
  useEditorStore.setState({ tabs: [], projectSessions: {} })
  useProjectStore.setState({
    currentProject: null,
    projects: [],
    projectTrees: {},
    loadProjects: vi.fn(async () => {}),
  })
})

describe('restore defaults', () => {
  it('repairs malformed global settings, resets preferences, and retains durable projects and trust', async () => {
    mocks.disk.set(globalPath, '{broken')
    mocks.disk.set(workspacePath, '{"editor.tabSize":9}')
    mocks.projects = [workspace, { ...workspace, kind: 'ssh', path: 'ssh://host/root' }]
    saveTheme('light')
    applyStoredFontSettings({ ...DEFAULT_FONT_SETTINGS, interfaceFontSize: 20 })
    saveTerminalProfileSettings({
      defaultShell: 'cmd',
      defaultProfileId: 'custom',
      profiles: [{ id: 'custom', name: 'Custom', shell: 'cmd', command: 'echo hello' }],
    })
    useShortcutStore.getState().setShortcut('openSettings', 'Alt+S')
    useLocaleStore.getState().setLanguage('en')
    localStorage.setItem('qingcode:workspace-trust', 'keep-trust')
    localStorage.setItem('qingcode:workspace-session', 'keep-session')
    await resetSettings('global')
    const next = JSON5.parse(mocks.disk.get(globalPath)!)
    expect(next).toEqual({
      ...defaultSettingsFor('global'),
      'qingcode.projects': [{ path: workspace.path, name: workspace.name, hidden: false }],
    })
    expect(mocks.disk.get(globalPath)).toContain('不得删除注释')
    expect(mocks.disk.get(globalPath)).toContain('// editor.tabSize')
    expect(loadTheme()).toBe(DEFAULT_THEME)
    expect(loadFontSettings()).toEqual(DEFAULT_FONT_SETTINGS)
    expect(loadTerminalProfileSettings().profiles).toEqual([DEFAULT_TERMINAL_PROFILE])
    expect(useShortcutStore.getState().shortcuts).toEqual(DEFAULT_SHORTCUTS)
    expect(useLocaleStore.getState().language).toBe(DEFAULT_LANGUAGE)
    expect(mocks.disk.get(workspacePath)).toBe('{"editor.tabSize":9}')
    expect(localStorage.getItem('qingcode:workspace-trust')).toBe('keep-trust')
    expect(localStorage.getItem('qingcode:workspace-session')).toBe('keep-session')
    expect(mocks.importProjects).not.toHaveBeenCalled()
    expect(useProjectStore.getState().loadProjects).not.toHaveBeenCalled()
  })

  it('clears workspace overrides so all options inherit the user settings', async () => {
    mocks.disk.set(globalPath, '{"editor.tabSize":8,"files.autoSave":"afterDelay"}')
    mocks.disk.set(workspacePath, '{version:1,custom:{old:1},"editor.tabSize":2,"plugin.key":true}')
    saveTheme('light')
    await resetSettings('project', workspace)
    expect(JSON5.parse(mocks.disk.get(workspacePath)!)).toEqual({ version: 1, custom: {} })
    expect(mocks.disk.get(workspacePath)).toContain('继承用户设置')
    expect(mocks.disk.get(globalPath)).toBe('{"editor.tabSize":8,"files.autoSave":"afterDelay"}')
    expect(loadTheme()).toBe('light')
  })

  it('protects unsaved files and applies preferences only after a successful write', async () => {
    useEditorStore.setState({
      tabs: [{ id: 'dirty', path: globalPath, name: 'settings', dirty: true, language: 'json' }],
    })
    await expect(resetSettings('global')).rejects.toThrow('未保存')
    expect(mocks.invoke.mock.calls.some(call => call[1] === 'write_file')).toBe(false)
    useEditorStore.setState({ tabs: [] })
    saveTheme('light')
    mocks.invoke.mockImplementation(async (_action, command) => {
      if (command === 'default_settings_path') return globalPath
      if (command === 'write_file') throw new Error('permission denied')
    })
    await expect(resetSettings('global')).rejects.toThrow('permission denied')
    expect(loadTheme()).toBe('light')
  })
})

describe('configuration validation', () => {
  it('accepts JSON5 and BOM and retains only workspace keys', () => {
    const result = parseSettingsTransfer(
      '\uFEFF{ // config\n "editor.tabSize": 2, "qingcode.projects": [], "qingcode.projectIndicators.enabled": false, }',
      'project'
    )
    expect(result.settings).toEqual({ 'editor.tabSize': 2 })
  })

  it.each([
    '[]',
    'null',
    '{',
    '{version:2}',
    '{custom:[]}',
    '{"editor.fontSize":NaN}',
    '{"qingcode.projects":[{path:"relative"}]}',
  ])('rejects invalid input %s', text => {
    expect(() => parseSettingsTransfer(text, 'global')).toThrow()
  })

  it('rejects mismatched scope and malformed preferences before writing', async () => {
    await expect(
      importSettings('{format:"qingcode-settings",version:1,scope:"project",settings:{}}', 'global')
    ).rejects.toThrow('范围')
    await expect(
      importSettings(
        '{format:"qingcode-settings",version:1,scope:"global",settings:{},preferences:{fonts:{}}}',
        'global'
      )
    ).rejects.toThrow('字体')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('comment-preserving patches', () => {
  it('handles strings, arrays, nested comments, escaped keys, and a missing trailing comma', () => {
    const source = `{\n// keep this comment\n"editor.tabSize": 4, // tabs\ncustom: {message: '} , //', nested: [1, {x:2}]},\n'extra': 'a\\\'b' // comment with ,\n}`
    const result = patchSettingsText(
      source,
      {
        'editor.tabSize': 2,
        custom: { message: 'x', array: ['}', '/*'] },
        'unknown.key': { a: 1 },
      },
      'project'
    )
    expect(result).toContain('// keep this comment')
    expect(result).toContain('// tabs')
    expect(result).toContain('// comment with ,')
    expect(JSON5.parse(result)).toEqual({
      'editor.tabSize': 2,
      custom: { message: 'x', array: ['}', '/*'] },
      extra: "a'b",
      'unknown.key': { a: 1 },
    })
  })

  it('keeps workspace inheritance and unknown fields without injecting defaults', () => {
    const result = patchSettingsText(
      '{version:1, custom:{}, "plugin.option":true}',
      { 'editor.tabSize': 2 },
      'project'
    )
    expect(JSON5.parse(result)).toEqual({
      version: 1,
      custom: {},
      'plugin.option': true,
      'editor.tabSize': 2,
    })
    expect(result).toContain('editor.tabSize：')
  })
})

describe('settings transfer journey', () => {
  it('round-trips workspace overrides without importing global defaults', async () => {
    mocks.disk.set(workspacePath, '{version:1,custom:{a:1},"editor.tabSize":2}')
    const exported = await exportSettings('project', workspace)
    mocks.disk.set(workspacePath, '// original\n{version:1,custom:{b:2},"plugin.key":true}')
    await importSettings(JSON.stringify(exported), 'project', workspace)
    expect(JSON5.parse(mocks.disk.get(workspacePath)!)).toEqual({
      version: 1,
      custom: { a: 1, b: 2 },
      'plugin.key': true,
      'editor.tabSize': 2,
    })
    expect(mocks.disk.get(workspacePath)).toContain('// original')
    expect(mocks.importProjects).not.toHaveBeenCalled()
    expect(mocks.apply).toHaveBeenCalled()
  })

  it('exports actual local projects and preferences, excluding SSH and ephemeral records', async () => {
    mocks.disk.set(globalPath, '{version:1,custom:{},"qingcode.projects":[]}')
    mocks.projects = [
      workspace,
      { ...workspace, id: 'ssh', kind: 'ssh', path: 'ssh://host/root' },
      { ...workspace, id: 'tmp', ephemeral: true },
    ]
    const result = await exportSettings('global')
    expect(result.settings['qingcode.projects']).toEqual([
      { path: workspace.path, name: workspace.name, hidden: false },
    ])
    expect(result.preferences?.theme).toBe('dark')
    expect(result.preferences?.shortcuts).toBeDefined()
  })

  it('merges projects by normalized path and reports skipped paths while applying preferences', async () => {
    mocks.disk.set(
      globalPath,
      '{version:1,custom:{old:1},"qingcode.projects":[{path:"D:/Existing",name:"old"}],"qingcode.projects.syncOnStartup":false}'
    )
    mocks.importProjects.mockResolvedValue(['D:/missing'])
    const text = JSON.stringify({
      format: 'qingcode-settings',
      version: 1,
      scope: 'global',
      settings: {
        custom: { new: 2 },
        'qingcode.projects': [{ path: 'd:\\existing', name: 'renamed' }, { path: 'D:/missing' }],
      },
      preferences: { theme: 'light' },
    })
    const result = await importSettings(text, 'global')
    const saved = JSON5.parse(mocks.disk.get(globalPath)!)
    expect(saved.custom).toEqual({ old: 1, new: 2 })
    expect(saved['qingcode.projects']).toHaveLength(2)
    expect(saved['qingcode.projects'][0].name).toBe('renamed')
    expect(saved['qingcode.projects.syncOnStartup']).toBe(false)
    expect(useProjectStore.getState().loadProjects).toHaveBeenCalledWith({ restoreCurrent: false })
    expect(result.skippedProjects).toEqual(['D:/missing'])
    expect(loadTheme()).toBe('light')
  })

  it('protects unsaved settings tabs and unreadable settings', async () => {
    useEditorStore.setState({
      tabs: [{ id: 'dirty', path: globalPath, name: 'settings', dirty: true, language: 'json' }],
    })
    await expect(importSettings('{"editor.tabSize":2}', 'global')).rejects.toThrow('未保存')
    expect(mocks.invoke.mock.calls.some(call => call[1] === 'write_file')).toBe(false)
    useEditorStore.setState({ tabs: [] })
    mocks.invoke.mockImplementation(async (_action, command) => {
      if (command === 'default_settings_path') return globalPath
      throw new Error('permission denied')
    })
    await expect(importSettings('{"editor.tabSize":2}', 'global')).rejects.toThrow(
      'permission denied'
    )
  })
})
