export interface Project {
  id: string
  name: string
  path: string
  default_shell?: string
  created_at: number
  last_opened_at: number
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
