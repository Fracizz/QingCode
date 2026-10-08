import JSON5 from 'json5'
import type { Project } from '../types'
import {
  defaultSettingsTextFor,
  defaultSettingsFor,
  formatSettings,
  PROJECTS_KEY,
  stripGlobalOnlyKeys,
  resolveGlobalSettingsPath,
  resolveProjectSettingsPath,
  validateSettings,
  type SettingsFile,
  type SettingsScope,
  type SettingsProjectEntry,
} from './projectSettings'
import { safeInvoke } from './tauri'
import { DEFAULT_THEME, loadTheme, saveTheme, type AppTheme } from './themeSettings'
import {
  DEFAULT_FONT_SETTINGS,
  loadFontSettings,
  applyStoredFontSettings,
  type FontSettings,
} from './fontSettings'
import {
  loadTerminalProfileSettings,
  DEFAULT_TERMINAL_PROFILE,
  saveTerminalProfileSettings,
  type TerminalProfileSettings,
} from './terminal/terminalProfiles'
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS, type ShortcutCommand } from './shortcuts'
import { DEFAULT_LANGUAGE, useLocaleStore } from './i18n'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { normalizeProjectPath } from '../utils/fileTreeHelpers'
import { applyEffectiveSettings } from './effectiveSettings'
import { importSettingsProjects, listProjects, withDb } from './projectRepository'
import { loadSessionPersistEnabled, notifySessionPersistChanged } from './sessionPersistSettings'
import {
  loadProjectIndicatorsEnabled,
  notifyProjectIndicatorsChanged,
} from './projectIndicatorSettings'
import { loadGitRefreshIntervalStartMinutes } from './gitRefreshSettings'

interface UserPreferences {
  theme?: AppTheme
  fonts?: FontSettings
  terminal?: TerminalProfileSettings
  shortcuts?: Partial<Record<ShortcutCommand, string>>
  language?: string
}

export interface SettingsTransfer {
  format: 'qingcode-settings'
  version: 1
  scope: SettingsScope
  settings: Record<string, unknown>
  preferences?: UserPreferences
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Strict parsing: malformed imports must never silently become default settings. */
export function parseSettingsTransfer(text: string, scope: SettingsScope): SettingsTransfer {
  const raw: unknown = JSON5.parse(text.replace(/^\uFEFF/, ''))
  if (!record(raw)) throw new Error('设置必须是 JSON 对象')
  const wrapped = raw.format === 'qingcode-settings'
  if (wrapped && (raw.version !== 1 || raw.scope !== scope)) {
    throw new Error('配置版本或设置范围不匹配')
  }
  const settings = wrapped ? raw.settings : raw
  if (!record(settings)) throw new Error('设置必须是 JSON 对象')
  const error = validateSettings({ version: 1, ...settings })
  if (error) throw new Error(error)
  // Re-encoding rejects non-JSON values accepted by JSON5 (Infinity / NaN).
  const checkValues = (value: unknown): void => {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('配置必须包含有效的 JSON 值')
    if (Array.isArray(value)) value.forEach(checkValues)
    else if (record(value)) Object.values(value).forEach(checkValues)
  }
  checkValues(raw)
  if (settings[PROJECTS_KEY] !== undefined) {
    for (const item of settings[PROJECTS_KEY] as unknown[]) {
      if (
        !record(item) ||
        typeof item.path !== 'string' ||
        !item.path.trim() ||
        item.path.startsWith('ssh://') ||
        !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(item.path) ||
        (item.name !== undefined && typeof item.name !== 'string') ||
        (item.hidden !== undefined && typeof item.hidden !== 'boolean') ||
        (item.defaultShell !== undefined && typeof item.defaultShell !== 'string')
      ) {
        throw new Error('项目列表必须包含有效的本地绝对路径')
      }
    }
  }
  const preferences = wrapped ? raw.preferences : undefined
  if (preferences !== undefined) {
    if (scope !== 'global' || !record(preferences)) throw new Error('用户偏好配置无效')
    if (
      preferences.theme !== undefined &&
      !['dark', 'light', 'olive', 'forest', 'auto'].includes(String(preferences.theme))
    )
      throw new Error('颜色主题无效')
    if (preferences.language !== undefined && typeof preferences.language !== 'string')
      throw new Error('语言配置无效')
    if (preferences.fonts !== undefined) {
      const fonts = preferences.fonts
      if (
        !record(fonts) ||
        typeof fonts.interfaceFont !== 'string' ||
        typeof fonts.monoFont !== 'string' ||
        ['interfaceFontSize', 'editorFontSize', 'terminalFontSize'].some(
          key => typeof fonts[key] !== 'number' || Number(fonts[key]) < 6 || Number(fonts[key]) > 72
        )
      )
        throw new Error('字体配置无效')
    }
    if (
      preferences.shortcuts !== undefined &&
      (!record(preferences.shortcuts) ||
        Object.entries(preferences.shortcuts).some(
          ([key, value]) =>
            !Object.prototype.hasOwnProperty.call(DEFAULT_SHORTCUTS, key) ||
            typeof value !== 'string'
        ))
    )
      throw new Error('快捷键配置无效')
    if (preferences.terminal !== undefined) {
      const terminal = preferences.terminal
      const shells = ['auto', 'powershell', 'pwsh', 'cmd', 'wsl', 'bash', 'zsh']
      if (
        !record(terminal) ||
        !Array.isArray(terminal.profiles) ||
        !shells.includes(String(terminal.defaultShell)) ||
        (terminal.defaultProfileId !== null && typeof terminal.defaultProfileId !== 'string') ||
        terminal.profiles.some(
          p =>
            !record(p) ||
            ['id', 'name', 'command'].some(key => typeof p[key] !== 'string') ||
            !shells.includes(String(p.shell))
        )
      )
        throw new Error('终端配置无效')
    }
  }
  const normalized = scope === 'project' ? stripGlobalOnlyKeys(settings as SettingsFile) : settings
  return {
    format: 'qingcode-settings',
    version: 1,
    scope,
    settings: normalized,
    preferences: preferences as UserPreferences | undefined,
  }
}

/** Patch top-level values only, retaining comments, unknown keys, and sparse workspace overrides. */
export function patchSettingsText(
  text: string,
  patch: Record<string, unknown>,
  scope: SettingsScope
): string {
  const current: unknown = JSON5.parse(text)
  if (!record(current)) throw new Error('设置必须是 JSON 对象')
  let pos = 0
  const skip = () => {
    while (pos < text.length) {
      if (/\s/.test(text[pos])) pos++
      else if (text.slice(pos, pos + 2) === '//') {
        while (pos < text.length && text[pos] !== '\n') pos++
      } else if (text.slice(pos, pos + 2) === '/*') {
        pos = text.indexOf('*/', pos + 2) + 2
      } else break
    }
  }
  const stringEnd = () => {
    const quote = text[pos++]
    while (pos < text.length) {
      if (text[pos++] === quote) break
      if (text[pos - 1] === '\\') pos++
    }
  }
  const spans = new Map<string, { start: number; end: number }>()
  let trailingComma = false
  skip()
  pos++
  while (pos < text.length) {
    skip()
    if (text[pos] === '}') break
    const keyStart = pos
    if (text[pos] === '"' || text[pos] === "'") stringEnd()
    else while (pos < text.length && !/[\s:]/.test(text[pos])) pos++
    const keyToken = text.slice(keyStart, pos)
    const key = Object.keys(JSON5.parse(`{${keyToken}:null}`) as object)[0]
    skip()
    pos++
    skip()
    const start = pos
    let depth = 0
    let end = pos
    while (pos < text.length) {
      const ch = text[pos]
      if (ch === '"' || ch === "'") {
        stringEnd()
        end = pos
      } else if (
        text.slice(pos, pos + 2) === '//' ||
        text.slice(pos, pos + 2) === '/*' ||
        /\s/.test(ch)
      )
        skip()
      else if (depth === 0 && (ch === ',' || ch === '}')) break
      else {
        if (ch === '{' || ch === '[') depth++
        if (ch === '}' || ch === ']') depth--
        pos++
        end = pos
      }
    }
    spans.set(key, { start, end })
    trailingComma = text[pos] === ','
    if (text[pos] === ',') pos++
  }
  const closing = pos
  const edits: { start: number; end: number; value: string }[] = []
  const extra: string[] = []
  const template = defaultSettingsTextFor(scope).split('\n')
  for (const [key, value] of Object.entries(patch)) {
    const encoded = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')
    const span = spans.get(key)
    if (span) edits.push({ ...span, value: encoded })
    else {
      const comment =
        template.find(line => line.trimStart().startsWith(`// ${key}：`)) ??
        `  // ${key}：导入的配置`
      extra.push(`${comment}\n  ${JSON.stringify(key)}: ${encoded},`)
    }
  }
  if (extra.length) {
    // A root without a trailing comma needs one before the appended properties.
    const last = [...spans.values()].at(-1)
    edits.push({ start: closing, end: closing, value: `\n${extra.join('\n')}\n` })
    if (last && !trailingComma) edits.push({ start: last.end, end: last.end, value: ',' })
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let result = text
  for (const edit of edits)
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
  JSON5.parse(result)
  if (!/\/\/|\/\*/.test(result)) result = `// QingCode 设置（JSON5），不得删除注释\n${result}`
  return result.endsWith('\n') ? result : `${result}\n`
}

async function settingsPath(scope: SettingsScope, project?: Project | null): Promise<string> {
  if (scope === 'global') return resolveGlobalSettingsPath()
  if (!project) throw new Error('请先选择项目，再配置项目设置。')
  return resolveProjectSettingsPath(project)
}

async function readSettingsText(path: string, scope: SettingsScope): Promise<string> {
  // file_mtime returns null only for a missing file; permission failures propagate.
  const mtime = await safeInvoke<number | null>('读取设置修改时间', 'file_mtime', { path })
  if (mtime === null)
    return scope === 'global'
      ? defaultSettingsTextFor(scope)
      : '{\n  // QingCode 工作区设置（JSON5），不得删除注释\n  // version：配置版本\n  version: 1,\n  // custom：自定义设置\n  custom: {},\n}\n'
  return safeInvoke<string>('读取设置', 'read_file', { path })
}

export async function exportSettings(
  scope: SettingsScope,
  project?: Project | null
): Promise<SettingsTransfer> {
  const path = await settingsPath(scope, project)
  assertCleanSettingsTab(path)
  const transfer = parseSettingsTransfer(await readSettingsText(path, scope), scope)
  if (scope === 'global') {
    transfer.settings[PROJECTS_KEY] = await portableProjectEntries()
    transfer.preferences = {
      theme: loadTheme(),
      fonts: loadFontSettings(),
      terminal: loadTerminalProfileSettings(),
      shortcuts: useShortcutStore.getState().shortcuts,
      language: useLocaleStore.getState().language,
    }
  }
  return transfer
}

async function portableProjectEntries(): Promise<SettingsProjectEntry[]> {
  const projects = await withDb('读取项目列表', listProjects)
  return projects
    .filter(p => !p.ephemeral && p.kind !== 'ssh' && !p.path.startsWith('ssh://'))
    .map(p => ({
      path: p.path,
      name: p.name,
      hidden: p.hidden === 1,
      ...(p.default_shell ? { defaultShell: p.default_shell } : {}),
    }))
}

/** Reset configuration only; never remove projects, trust decisions, or session data. */
export async function resetSettings(
  scope: SettingsScope,
  project?: Project | null
): Promise<{ scope: SettingsScope }> {
  const path = await settingsPath(scope, project)
  assertCleanSettingsTab(path)
  const content =
    scope === 'global'
      ? formatSettings(
          { ...defaultSettingsFor('global'), [PROJECTS_KEY]: await portableProjectEntries() },
          'global'
        )
      : '{\n  // QingCode 工作区设置（JSON5），不得删除注释\n  // 恢复默认后，未设置的选项继承用户设置\n  // version：配置版本\n  version: 1,\n  // custom：自定义设置\n  custom: {},\n}\n'
  assertCleanSettingsTab(path)
  await safeInvoke('恢复默认设置', 'write_file', { path, content })
  if (scope === 'global') {
    saveTheme(DEFAULT_THEME)
    applyStoredFontSettings({ ...DEFAULT_FONT_SETTINGS })
    saveTerminalProfileSettings({
      profiles: [{ ...DEFAULT_TERMINAL_PROFILE }],
      defaultShell: DEFAULT_TERMINAL_PROFILE.shell,
      defaultProfileId: null,
    })
    useShortcutStore.getState().resetShortcuts()
    useLocaleStore.getState().setLanguage(DEFAULT_LANGUAGE)
  }
  await finishSettingsChange(scope, path, content)
  return { scope }
}

function assertCleanSettingsTab(path: string) {
  if (
    useEditorStore
      .getState()
      .getAllTabs()
      .some(tab => tab.dirty && normalizeProjectPath(tab.path) === normalizeProjectPath(path))
  )
    throw new Error('请先保存或撤销设置文件中的未保存修改')
}

export async function importSettings(
  text: string,
  scope: SettingsScope,
  project?: Project | null
): Promise<{ scope: SettingsScope; skippedProjects: string[] }> {
  const transfer = parseSettingsTransfer(text, scope)
  const path = await settingsPath(scope, project)
  assertCleanSettingsTab(path)
  const existing = await readSettingsText(path, scope)
  const patch = { ...transfer.settings }
  if (record(patch.custom))
    patch.custom = { ...(JSON5.parse(existing) as SettingsFile).custom, ...patch.custom }
  const importedProjects = patch[PROJECTS_KEY] as SettingsProjectEntry[] | undefined
  if (importedProjects) {
    const current = (JSON5.parse(existing) as SettingsFile)[PROJECTS_KEY]
    const merged = new Map<string, SettingsProjectEntry>()
    for (const item of [...(Array.isArray(current) ? current : []), ...importedProjects])
      merged.set(normalizeProjectPath(item.path), item)
    patch[PROJECTS_KEY] = [...merged.values()]
  }
  const content = patchSettingsText(existing, patch, scope)
  assertCleanSettingsTab(path)
  await safeInvoke('导入配置', 'write_file', { path, content })
  const preferences = transfer.preferences
  if (preferences) {
    if (preferences.theme) saveTheme(preferences.theme)
    if (preferences.fonts) applyStoredFontSettings(preferences.fonts)
    if (preferences.terminal) saveTerminalProfileSettings(preferences.terminal)
    if (preferences.shortcuts)
      for (const [key, value] of Object.entries(preferences.shortcuts))
        useShortcutStore.getState().setShortcut(key as ShortcutCommand, value)
    if (preferences.language) useLocaleStore.getState().setLanguage(preferences.language)
  }
  const skippedProjects = importedProjects ? await importSettingsProjects(importedProjects) : []
  if (importedProjects) await useProjectStore.getState().loadProjects({ restoreCurrent: false })
  await finishSettingsChange(scope, path, content)
  return { scope, skippedProjects }
}

async function finishSettingsChange(
  scope: SettingsScope,
  path: string,
  content: string
): Promise<void> {
  await applyEffectiveSettings(useProjectStore.getState().currentProject)
  if (scope === 'global') {
    notifySessionPersistChanged(await loadSessionPersistEnabled())
    notifyProjectIndicatorsChanged(await loadProjectIndicatorsEnabled())
    await loadGitRefreshIntervalStartMinutes()
  }
  const editor = useEditorStore.getState()
  for (const tab of editor.getAllTabs())
    if (normalizeProjectPath(tab.path) === normalizeProjectPath(path)) {
      editor.setTabContent(tab.id, content)
      editor.markClean(tab.id)
      editor.bumpContentEpoch(tab.id)
      editor.setDiskMtime(
        tab.id,
        await safeInvoke<number | null>('读取设置修改时间', 'file_mtime', { path })
      )
    }
  const store = useProjectStore.getState()
  for (const p of store.projects) if (store.projectTrees[p.id]) void store.refreshProjectTree(p)
  if (store.currentProject) void store.loadFileTree()
  window.dispatchEvent(new Event('qingcode:settings-imported'))
}
