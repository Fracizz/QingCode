import type { Project } from '../types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  resolveProjectSettingsPath,
  saveGlobalSettings,
  saveProjectSettings,
  settingsFileExists,
  type SettingsFile,
} from './projectSettings'
import { mergeSettings } from './autoSaveSettings'
import { getPendingEditorFontSize, syncEditorFontSizeFromPreferences } from './fontSettings'

export const EDITOR_SETTINGS_EVENT = 'qingcode:editor-settings-changed'

export type WordWrapMode = 'off' | 'on' | 'wordWrapColumn' | 'bounded'
export type LineNumbersMode = 'on' | 'off' | 'relative' | 'interval'
export type RenderWhitespaceMode = 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
export type EolMode = 'auto' | 'LF' | 'CRLF'
export type FileEncoding =
  | 'auto'
  | 'utf8'
  | 'utf8bom'
  | 'utf16le'
  | 'utf16be'
  | 'gbk'
  | 'gb18030'
export type WritableFileEncoding = Exclude<FileEncoding, 'auto'>

export type EditorPreferenceSettings = {
  fontSize: number
  tabSize: number
  insertSpaces: boolean
  detectIndentation: boolean
  wordWrap: WordWrapMode
  lineNumbers: LineNumbersMode
  renderWhitespace: RenderWhitespaceMode
  trimTrailingWhitespace: boolean
  insertFinalNewline: boolean
  eol: EolMode
  encoding: FileEncoding
  formatOnPaste: boolean
  bracketPairColorization: boolean
  guidesEnabled: boolean
  bracketPairGuides: boolean
  indentationGuides: boolean
  highlightActiveIndentation: boolean
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferenceSettings = {
  fontSize: DEFAULT_GLOBAL_SETTINGS['editor.fontSize'] as number,
  tabSize: DEFAULT_GLOBAL_SETTINGS['editor.tabSize'] as number,
  insertSpaces: DEFAULT_GLOBAL_SETTINGS['editor.insertSpaces'] as boolean,
  detectIndentation: DEFAULT_GLOBAL_SETTINGS['editor.detectIndentation'] as boolean,
  wordWrap: 'off',
  lineNumbers: 'on',
  renderWhitespace: 'selection',
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  eol: 'auto',
  encoding: 'auto',
  formatOnPaste: false,
  bracketPairColorization: true,
  guidesEnabled: true,
  bracketPairGuides: true,
  indentationGuides: true,
  highlightActiveIndentation: true,
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(64, Math.max(1, Math.round(n)))
}

function asFontSize(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(48, Math.max(8, Math.round(n)))
}

/**
 * User-scoped editor font size: global settings (+ optional in-flight UI value),
 * never workspace defaults (templates pin 14 and would undo the Settings control).
 */
export function resolveUserEditorFontSize(
  globalFontSize: unknown,
  pending: number | null = null,
  fallback: number = DEFAULT_EDITOR_PREFERENCES.fontSize,
): number {
  if (pending != null) return asFontSize(pending, fallback)
  return asFontSize(globalFontSize, fallback)
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asWordWrap(value: unknown): WordWrapMode {
  if (value === 'on' || value === 'wordWrapColumn' || value === 'bounded' || value === 'off') {
    return value
  }
  return 'off'
}

function asLineNumbers(value: unknown): LineNumbersMode {
  if (value === 'off' || value === 'relative' || value === 'interval' || value === 'on') {
    return value
  }
  return 'on'
}

function asWhitespace(value: unknown): RenderWhitespaceMode {
  if (
    value === 'none' ||
    value === 'boundary' ||
    value === 'selection' ||
    value === 'trailing' ||
    value === 'all'
  ) {
    return value
  }
  return 'selection'
}

function asEol(value: unknown): EolMode {
  if (value === 'LF' || value === 'CRLF' || value === 'auto') return value
  return 'auto'
}

export function asFileEncoding(value: unknown): FileEncoding {
  if (
    value === 'auto' ||
    value === 'utf8bom' ||
    value === 'utf16le' ||
    value === 'utf16be' ||
    value === 'gbk' ||
    value === 'gb18030' ||
    value === 'utf8'
  ) {
    return value
  }
  return 'utf8'
}

export function readEditorPreferences(settings: SettingsFile): EditorPreferenceSettings {
  return {
    fontSize: asFontSize(settings['editor.fontSize'], DEFAULT_EDITOR_PREFERENCES.fontSize),
    tabSize: asNumber(settings['editor.tabSize'], DEFAULT_EDITOR_PREFERENCES.tabSize),
    insertSpaces: asBoolean(settings['editor.insertSpaces'], DEFAULT_EDITOR_PREFERENCES.insertSpaces),
    detectIndentation: asBoolean(
      settings['editor.detectIndentation'],
      DEFAULT_EDITOR_PREFERENCES.detectIndentation,
    ),
    wordWrap: asWordWrap(settings['editor.wordWrap']),
    lineNumbers: asLineNumbers(settings['editor.lineNumbers']),
    renderWhitespace: asWhitespace(settings['editor.renderWhitespace']),
    trimTrailingWhitespace: asBoolean(
      settings['files.trimTrailingWhitespace'],
      DEFAULT_EDITOR_PREFERENCES.trimTrailingWhitespace,
    ),
    insertFinalNewline: asBoolean(
      settings['files.insertFinalNewline'],
      DEFAULT_EDITOR_PREFERENCES.insertFinalNewline,
    ),
    eol: asEol(settings['files.eol']),
    encoding: asFileEncoding(settings['files.encoding']),
    formatOnPaste: asBoolean(
      settings['editor.formatOnPaste'],
      DEFAULT_EDITOR_PREFERENCES.formatOnPaste,
    ),
    bracketPairColorization: asBoolean(
      settings['editor.bracketPairColorization.enabled'],
      DEFAULT_EDITOR_PREFERENCES.bracketPairColorization,
    ),
    guidesEnabled: asBoolean(
      settings['editor.guides.enabled'],
      DEFAULT_EDITOR_PREFERENCES.guidesEnabled,
    ),
    bracketPairGuides: asBoolean(
      settings['editor.guides.bracketPairs'],
      DEFAULT_EDITOR_PREFERENCES.bracketPairGuides,
    ),
    indentationGuides: asBoolean(
      settings['editor.guides.indentation'],
      DEFAULT_EDITOR_PREFERENCES.indentationGuides,
    ),
    highlightActiveIndentation: asBoolean(
      settings['editor.guides.highlightActiveIndentation'],
      DEFAULT_EDITOR_PREFERENCES.highlightActiveIndentation,
    ),
  }
}

let cached: EditorPreferenceSettings = { ...DEFAULT_EDITOR_PREFERENCES }

export function getEditorPreferences(): EditorPreferenceSettings {
  return cached
}

export function notifyEditorSettingsChanged(settings: EditorPreferenceSettings) {
  cached = settings
  window.dispatchEvent(new CustomEvent(EDITOR_SETTINGS_EVENT, { detail: settings }))
}

export async function loadEffectiveEditorPreferences(
  project?: Project | null,
): Promise<EditorPreferenceSettings> {
  const global = await loadGlobalSettings()
  const workspaceExists = project
    ? await settingsFileExists(await resolveProjectSettingsPath(project))
    : false
  const workspace = project ? await loadProjectSettings(project) : null
  const prefs = readEditorPreferences(mergeSettings(global, workspace))
  // A missing workspace file resolves to the full workspace defaults. Do not
  // let that synthetic `true` override the user's global master switch.
  if (project && !workspaceExists) {
    prefs.guidesEnabled = asBoolean(
      global['editor.guides.enabled'],
      DEFAULT_EDITOR_PREFERENCES.guidesEnabled,
    )
  }
  // editor.fontSize is user-scoped in the Settings UI. Workspace templates always
  // ship `"editor.fontSize": 14`, which previously overwrote the user choice whenever
  // the editor remounted after leaving Settings.
  prefs.fontSize = resolveUserEditorFontSize(
    global['editor.fontSize'],
    getPendingEditorFontSize(),
  )
  notifyEditorSettingsChanged(prefs)
  syncEditorFontSizeFromPreferences(prefs.fontSize)
  return prefs
}

export async function loadScopedEditorGuidesEnabled(
  scope: 'global' | 'project',
  project?: Project | null,
): Promise<boolean> {
  const settings =
    scope === 'project' && project
      ? await loadProjectSettings(project)
      : await loadGlobalSettings()
  return asBoolean(
    settings['editor.guides.enabled'],
    DEFAULT_EDITOR_PREFERENCES.guidesEnabled,
  )
}

export async function saveScopedEditorGuidesEnabled(
  scope: 'global' | 'project',
  enabled: boolean,
  project?: Project | null,
): Promise<void> {
  if (scope === 'project' && project) {
    const current = await loadProjectSettings(project)
    current['editor.guides.enabled'] = enabled
    await saveProjectSettings(project, current)
  } else {
    const current = await loadGlobalSettings()
    current['editor.guides.enabled'] = enabled
    await saveGlobalSettings(current)
  }
  await loadEffectiveEditorPreferences(project)
}

/** Prepare buffer for disk using files.* save settings. */
export function prepareContentForSave(
  content: string,
  prefs: EditorPreferenceSettings = cached,
): string {
  let next = content
  if (prefs.trimTrailingWhitespace) {
    next = next
      .split(/\r?\n/)
      .map(line => line.replace(/[ \t]+$/g, ''))
      .join('\n')
  }

  const wantsCrlf = prefs.eol === 'CRLF' || (prefs.eol === 'auto' && content.includes('\r\n'))
  // Normalize to LF first for insertFinalNewline, then convert EOL.
  next = next.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  if (prefs.insertFinalNewline) {
    if (next.length === 0 || !next.endsWith('\n')) next = `${next}\n`
  }

  if (wantsCrlf) {
    next = next.replace(/\n/g, '\r\n')
  }
  return next
}

type SpaceDifference = {
  spaces: number
  looksLikeAlignment: boolean
}

function indentationWidth(line: string): {
  width: number
  spaces: number
  tabs: number
  hasContent: boolean
} {
  let spaces = 0
  let tabs = 0
  let width = 0
  for (; width < line.length; width++) {
    if (line[width] === ' ') spaces++
    else if (line[width] === '\t') tabs++
    else break
  }
  return { width, spaces, tabs, hasContent: width < line.length }
}

/** Port of VS Code's adjacent-line indentation difference heuristic. */
function indentationDifference(
  previous: string,
  previousWidth: number,
  current: string,
  currentWidth: number,
): SpaceDifference {
  let shared = 0
  while (
    shared < previousWidth &&
    shared < currentWidth &&
    previous[shared] === current[shared]
  ) {
    shared++
  }

  const previousTail = previous.slice(shared, previousWidth)
  const currentTail = current.slice(shared, currentWidth)
  const previousSpaces = previousTail.split(' ').length - 1
  const currentSpaces = currentTail.split(' ').length - 1
  const previousTabs = previousTail.split('\t').length - 1
  const currentTabs = currentTail.split('\t').length - 1

  if (
    (previousSpaces > 0 && previousTabs > 0) ||
    (currentSpaces > 0 && currentTabs > 0)
  ) {
    return { spaces: 0, looksLikeAlignment: false }
  }

  const tabsDiff = Math.abs(previousTabs - currentTabs)
  const spacesDiff = Math.abs(previousSpaces - currentSpaces)
  if (tabsDiff === 0) {
    const looksLikeAlignment =
      spacesDiff > 0 &&
      currentSpaces > 0 &&
      currentSpaces < previous.length &&
      currentSpaces < current.length &&
      current[currentSpaces] !== ' ' &&
      previous[currentSpaces - 1] === ' ' &&
      previous.endsWith(',')
    return { spaces: spacesDiff, looksLikeAlignment }
  }
  return {
    spaces: spacesDiff % tabsDiff === 0 ? spacesDiff / tabsDiff : 0,
    looksLikeAlignment: false,
  }
}

/** VS Code-style indent detection from adjacent non-empty lines. */
export function detectIndentFromContent(
  content: string,
): { tabSize: number; insertSpaces: boolean } | null {
  const lines = content.split(/\r?\n/).slice(0, 10_000)
  let tabIndents = 0
  let spaceIndents = 0
  let previousLine = ''
  let previousWidth = 0
  const scores = new Array<number>(9).fill(0)

  for (const line of lines) {
    const info = indentationWidth(line)
    if (!info.hasContent) continue

    if (info.tabs > 0) tabIndents++
    else if (info.spaces > 1) spaceIndents++

    const difference = indentationDifference(
      previousLine,
      previousWidth,
      line,
      info.width,
    )
    if (
      !difference.looksLikeAlignment ||
      (cached.insertSpaces && cached.tabSize === difference.spaces)
    ) {
      if (difference.spaces > 0 && difference.spaces <= 8) {
        scores[difference.spaces]++
      }
    }
    previousLine = line
    previousWidth = info.width
  }

  if (tabIndents === 0 && spaceIndents === 0) return null
  const insertSpaces =
    tabIndents === spaceIndents
      ? cached.insertSpaces
      : tabIndents < spaceIndents
  if (!insertSpaces) return { tabSize: cached.tabSize, insertSpaces: false }

  let tabSize = cached.tabSize
  let bestScore = 0
  for (const possible of [2, 4, 6, 8, 3, 5, 7]) {
    if (scores[possible] > bestScore) {
      bestScore = scores[possible]
      tabSize = possible
    }
  }
  if (
    tabSize === 4 &&
    scores[4] > 0 &&
    scores[2] > 0 &&
    scores[2] >= (scores[4] * 2) / 3
  ) {
    tabSize = 2
  }
  return { tabSize, insertSpaces: true }
}
