import type { OpenFileErrorKind } from './lib/openFileError'

export interface Project {
  id: string
  name: string
  path: string
  default_shell?: string
  created_at: number
  last_opened_at: number
  /** 0 = visible in top bar, 1 = hidden from top bar display only. */
  hidden?: number
  /** Manual ordering weight; lower sorts first. Defaults to 0. */
  sort_order?: number
  /** In-memory only; not persisted to the projects table and lost on restart. */
  ephemeral?: boolean
}

export interface RecentFile {
  project_id: string
  path: string
  opened_at: number
}

export interface EditorTab {
  id: string
  path: string
  name: string
  dirty: boolean
  content?: string
  language?: string
  /**
   * `view` = read-only slice viewer for files above the plain-edit cap (100–500MB).
   * Default / omitted = CodeMirror edit (full / degraded / plain by size).
   */
  viewMode?: 'edit' | 'view'
  /** On-disk size in bytes when known (used by large-file viewer). */
  fileSize?: number
  /** Session encoding used for read/write (from files.encoding at open). */
  encoding?: 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gbk' | 'gb18030'
  /** True while read_file is in flight (progressive open). */
  loading?: boolean
  /** Set when read_file failed; tab stays open like VS Code error editors. */
  openError?: string
  openErrorKind?: OpenFileErrorKind
  /** Last known on-disk mtime (unix ms) when content was loaded/saved. */
  diskMtime?: number | null
  /** Bumped to force CodeMirror session rebuild after external reload / draft restore. */
  contentEpoch?: number
  /** When set, the main editor shows a read-only HEAD ↔ working-tree compare. */
  kind?: 'edit' | 'diff'
  /** HEAD (or empty) side of a diff tab. */
  originalContent?: string
}

export interface TerminalTab {
  id: string
  name: string
  projectId: string
  cwd: string
  /** Command/script path shown in the terminal and reused on restart. */
  launchCommand: string
  /** When set, spawn/restart uses `spawn_script` with this kind (run-config tasks). */
  shellKind?: 'ps1' | 'bat' | 'sh' | 'command' | 'script'
  env?: Record<string, string>
  /** Profile used to spawn this terminal (settings → 终端). */
  profileId?: string
  /** When true, OSC/window title updates may rename the tab (profile terminals). */
  allowTitleRename?: boolean
  status: 'starting' | 'running' | 'exited'
  exitCode: number | null
  /** Wall-clock ms when the process was spawned; used to detect quick failures. */
  startedAt?: number
  /**
   * Set when terminal metadata was restored after app restart; cleared after
   * the first spawn attempt so user-exited tabs are not auto-restarted.
   */
  awaitingRestoreSpawn?: boolean
  /**
   * Transient: restore respawn kept prior scrollback; Terminal.tsx appends a
   * separator instead of resetting xterm.
   */
  restorePreservedOutput?: boolean
}
