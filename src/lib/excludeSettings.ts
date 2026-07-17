import type { Project } from '../types'
import {
  DEFAULT_GLOBAL_SETTINGS,
  loadGlobalSettings,
  loadProjectSettings,
  type SettingsFile,
} from './projectSettings'

/** Merge global + workspace for exclude reads (avoids importing autoSaveSettings). */
function mergeForExclude(global: SettingsFile, workspace?: SettingsFile | null): SettingsFile {
  if (!workspace) return global
  const merged: SettingsFile = {
    ...global,
    custom: { ...global.custom, ...(workspace.custom ?? {}) },
  }
  for (const [key, value] of Object.entries(workspace)) {
    if (key === 'version' || key === 'custom') continue
    if (key === 'files.exclude' || key === 'search.exclude') {
      merged[key] = mergeExcludeMaps(merged[key], value)
      continue
    }
    merged[key] = value
  }
  return merged
}

export const EXCLUDE_SETTINGS_EVENT = 'qingcode:exclude-settings-changed'

export type ExcludeMap = Record<string, boolean>

export type EffectiveExcludeSettings = {
  /** Enabled `files.exclude` patterns (explorer). */
  filesExclude: string[]
  /** Enabled patterns for search = files.exclude ∪ search.exclude (true wins unless false). */
  searchExclude: string[]
  /** Hide paths matched by `.gitignore` / ignore files in the explorer. */
  excludeGitIgnore: boolean
  /** Honor ignore files during content / filename search. */
  useIgnoreFiles: boolean
  /** Follow symbolic links while searching. */
  followSymlinks: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function mergeExcludeMaps(base: unknown, override: unknown): ExcludeMap {
  const out: ExcludeMap = {}
  for (const source of [base, override]) {
    if (!isRecord(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'boolean' && key.trim()) {
        out[key] = value
      }
    }
  }
  return out
}

/** Read one exclude object, filling missing keys from defaults. */
export function readExcludeMap(
  settings: SettingsFile,
  key: 'files.exclude' | 'search.exclude',
): ExcludeMap {
  const defaults = DEFAULT_GLOBAL_SETTINGS[key]
  return mergeExcludeMaps(defaults, settings[key])
}

/** Patterns whose value is `true` (excluded). */
export function enabledExcludePatterns(map: ExcludeMap): string[] {
  return Object.entries(map)
    .filter(([, enabled]) => enabled)
    .map(([pattern]) => pattern)
}

/**
 * VS Code–style glob match for a relative path (POSIX separators).
 * `*` matches within a segment; `**` matches across segments; `?` is one char.
 * A match on any path prefix also counts (excluding a folder hides its children).
 */
export function pathMatchesExclude(relativePath: string, pattern: string): boolean {
  const path = normalizeRel(relativePath)
  const pat = normalizeRel(pattern)
  if (!path || !pat) return false

  const prefixes = pathPrefixes(path)
  return prefixes.some(prefix => vscodeGlobMatch(prefix, pat))
}

export function isPathExcluded(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  return patterns.some(pattern => pathMatchesExclude(relativePath, pattern))
}

function normalizeRel(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function pathPrefixes(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = []
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    out.push(acc)
  }
  return out
}

/** Segment-aware glob: `**` spans `/`, `*` does not. */
export function vscodeGlobMatch(text: string, pattern: string): boolean {
  try {
    return vscodeGlobToRegExp(pattern).test(text)
  } catch {
    return false
  }
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Convert a VS Code–style glob to a RegExp anchored to the full string. */
export function vscodeGlobToRegExp(pattern: string): RegExp {
  let i = 0
  let out = '^'
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // `**/` → zero or more complete segments
        out += '(?:.*/)?'
        i += 3
      } else {
        out += '.*'
        i += 2
      }
    } else if (pattern[i] === '*') {
      out += '[^/]*'
      i += 1
    } else if (pattern[i] === '?') {
      out += '[^/]'
      i += 1
    } else {
      out += escapeRegExp(pattern[i]!)
      i += 1
    }
  }
  out += '$'
  return new RegExp(out)
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function readEffectiveExcludeSettings(settings: SettingsFile): EffectiveExcludeSettings {
  const filesMap = readExcludeMap(settings, 'files.exclude')
  const searchMap = mergeExcludeMaps(filesMap, readExcludeMap(settings, 'search.exclude'))
  return {
    filesExclude: enabledExcludePatterns(filesMap),
    searchExclude: enabledExcludePatterns(searchMap),
    excludeGitIgnore: asBoolean(
      settings['explorer.excludeGitIgnore'],
      DEFAULT_GLOBAL_SETTINGS['explorer.excludeGitIgnore'] as boolean,
    ),
    useIgnoreFiles: asBoolean(
      settings['search.useIgnoreFiles'],
      DEFAULT_GLOBAL_SETTINGS['search.useIgnoreFiles'] as boolean,
    ),
    followSymlinks: asBoolean(
      settings['search.followSymlinks'],
      DEFAULT_GLOBAL_SETTINGS['search.followSymlinks'] as boolean,
    ),
  }
}

let cached: EffectiveExcludeSettings = readEffectiveExcludeSettings(DEFAULT_GLOBAL_SETTINGS)

export function getExcludeSettings(): EffectiveExcludeSettings {
  return cached
}

export function notifyExcludeSettingsChanged(settings: EffectiveExcludeSettings) {
  cached = settings
  window.dispatchEvent(new CustomEvent(EXCLUDE_SETTINGS_EVENT, { detail: settings }))
}

export async function loadEffectiveExcludeSettings(
  project?: Project | null,
): Promise<EffectiveExcludeSettings> {
  const global = await loadGlobalSettings()
  const workspace = project ? await loadProjectSettings(project) : null
  const next = readEffectiveExcludeSettings(mergeForExclude(global, workspace))
  notifyExcludeSettingsChanged(next)
  return next
}

/** Per-project exclude patterns (does not update the global cache). */
export async function loadExcludeSettingsForProject(
  project?: Project | null,
): Promise<EffectiveExcludeSettings> {
  const global = await loadGlobalSettings()
  if (!project) return readEffectiveExcludeSettings(global)
  const workspace = await loadProjectSettings(project)
  return readEffectiveExcludeSettings(mergeForExclude(global, workspace))
}
