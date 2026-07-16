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
  status: 'starting' | 'running' | 'exited'
  exitCode: number | null
}
