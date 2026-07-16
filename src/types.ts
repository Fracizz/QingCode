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
}
