import type { Project } from '../types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  type SettingsFile,
} from './projectSettings'
import { mergeSettings } from './autoSaveSettings'

export const EDITOR_SETTINGS_EVENT = 'qingcode:editor-settings-changed'

export type WordWrapMode = 'off' | 'on' | 'wordWrapColumn' | 'bounded'
export type LineNumbersMode = 'on' | 'off' | 'relative' | 'interval'
export type RenderWhitespaceMode = 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
export type EolMode = 'auto' | 'LF' | 'CRLF'

export type EditorPreferenceSettings = {
  tabSize: number
  insertSpaces: boolean
  detectIndentation: boolean
  wordWrap: WordWrapMode
  lineNumbers: LineNumbersMode
  renderWhitespace: RenderWhitespaceMode
  trimTrailingWhitespace: boolean
  insertFinalNewline: boolean
  eol: EolMode
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferenceSettings = {
  tabSize: DEFAULT_GLOBAL_SETTINGS['editor.tabSize'] as number,
  insertSpaces: DEFAULT_GLOBAL_SETTINGS['editor.insertSpaces'] as boolean,
  detectIndentation: DEFAULT_GLOBAL_SETTINGS['editor.detectIndentation'] as boolean,
  wordWrap: 'off',
  lineNumbers: 'on',
  renderWhitespace: 'selection',
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  eol: 'auto',
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(64, Math.max(1, Math.round(n)))
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

export function readEditorPreferences(settings: SettingsFile): EditorPreferenceSettings {
  return {
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
  const workspace = project ? await loadProjectSettings(project) : null
  const prefs = readEditorPreferences(mergeSettings(global, workspace))
  notifyEditorSettingsChanged(prefs)
  return prefs
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

/** Heuristic indent detection from file content (first indented non-empty lines). */
export function detectIndentFromContent(
  content: string,
): { tabSize: number; insertSpaces: boolean } | null {
  const lines = content.split(/\r?\n/).slice(0, 200)
  let tabIndents = 0
  let spaceIndents = 0
  const spaceWidths: number[] = []
  for (const line of lines) {
    if (!line || line.startsWith(' ') === false && !line.startsWith('\t')) continue
    if (line.startsWith('\t')) {
      tabIndents++
      continue
    }
    const m = line.match(/^( +)/)
    if (m) {
      spaceIndents++
      spaceWidths.push(m[1].length)
    }
  }
  if (tabIndents === 0 && spaceIndents === 0) return null
  if (tabIndents > spaceIndents) return { tabSize: cached.tabSize, insertSpaces: false }
  // Guess common width (2 or 4).
  const counts = new Map<number, number>()
  for (const w of spaceWidths) {
    for (const unit of [2, 4, 8]) {
      if (w % unit === 0) counts.set(unit, (counts.get(unit) ?? 0) + 1)
    }
  }
  let best = 4
  let bestCount = 0
  for (const [unit, count] of counts) {
    if (count > bestCount) {
      best = unit
      bestCount = count
    }
  }
  return { tabSize: best, insertSpaces: true }
}
