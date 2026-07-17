/**
 * Durable workspace session snapshot (tabs + terminal metadata) in localStorage.
 *
 * Dirty buffer bodies live in `draftRecovery` (`qingcode:unsaved-drafts`); this
 * snapshot only records tab paths / dirty flags / optional scroll, and terminal
 * metadata. PTY scrollback / command history live in `terminalSessionPersist`.
 * Shared across windows — fresh windows must not overwrite it
 * (see `shouldRestoreWorkspace`).
 */

export const WORKSPACE_SESSION_KEY = 'qingcode:workspace-sessions'
export const WORKSPACE_SESSION_VERSION = 1 as const

export type PersistedScrollPos = {
  top: number
  left: number
}

export type PersistedEditorTab = {
  id: string
  path: string
  name: string
  dirty: boolean
  language?: string
  scroll?: PersistedScrollPos
  /** Restored large files reopen in the slice viewer. */
  viewMode?: 'view'
}

export type PersistedTerminalMeta = {
  id: string
  name: string
  cwd: string
  launchCommand: string
  shellKind?: 'ps1' | 'bat' | 'sh' | 'command' | 'script'
  env?: Record<string, string>
  profileId?: string
  allowTitleRename?: boolean
}

export type PersistedProjectSession = {
  tabs: PersistedEditorTab[]
  activeTabId: string | null
  terminals: PersistedTerminalMeta[]
  activeTerminalId: string | null
}

export type WorkspaceSessionSnapshot = {
  version: typeof WORKSPACE_SESSION_VERSION
  updatedAt: number
  /** Global default-settings.json tabs that stay visible across project switches. */
  pinnedTabs?: PersistedEditorTab[]
  projects: Record<string, PersistedProjectSession>
}

export type EditorTabSnapshotInput = {
  id: string
  path: string
  name: string
  dirty: boolean
  language?: string
  scroll?: PersistedScrollPos | null
  viewMode?: 'edit' | 'view'
}

export type TerminalSnapshotInput = {
  id: string
  name: string
  projectId: string
  cwd: string
  launchCommand: string
  shellKind?: 'ps1' | 'bat' | 'sh' | 'command' | 'script'
  env?: Record<string, string>
  profileId?: string
  allowTitleRename?: boolean
}

export type ProjectEditorSessionInput = {
  tabs: EditorTabSnapshotInput[]
  activeTabId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseScroll(value: unknown): PersistedScrollPos | undefined {
  if (!isRecord(value)) return undefined
  const top = value.top
  const left = value.left
  if (typeof top !== 'number' || typeof left !== 'number') return undefined
  if (!Number.isFinite(top) || !Number.isFinite(left)) return undefined
  return { top, left }
}

function parseEditorTab(value: unknown): PersistedEditorTab | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.path !== 'string' || !value.path) return null
  if (typeof value.name !== 'string') return null
  const tab: PersistedEditorTab = {
    id: value.id,
    path: value.path,
    name: value.name,
    dirty: value.dirty === true,
  }
  if (typeof value.language === 'string') tab.language = value.language
  const scroll = parseScroll(value.scroll)
  if (scroll) tab.scroll = scroll
  if (value.viewMode === 'view') tab.viewMode = 'view'
  return tab
}

function parseTerminal(value: unknown): PersistedTerminalMeta | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.name !== 'string') return null
  if (typeof value.cwd !== 'string') return null
  if (typeof value.launchCommand !== 'string') return null
  const terminal: PersistedTerminalMeta = {
    id: value.id,
    name: value.name,
    cwd: value.cwd,
    launchCommand: value.launchCommand,
  }
  const shellKind = value.shellKind
  if (
    shellKind === 'ps1' ||
    shellKind === 'bat' ||
    shellKind === 'sh' ||
    shellKind === 'command' ||
    shellKind === 'script'
  ) {
    terminal.shellKind = shellKind
  }
  if (isRecord(value.env)) {
    const env: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value.env)) {
      if (typeof entry === 'string') env[key] = entry
    }
    if (Object.keys(env).length > 0) terminal.env = env
  }
  if (typeof value.profileId === 'string') terminal.profileId = value.profileId
  if (typeof value.allowTitleRename === 'boolean') {
    terminal.allowTitleRename = value.allowTitleRename
  }
  return terminal
}

/** Parse one project's tab/terminal session; returns null when the value is unusable. */
export function parseProjectSession(value: unknown): PersistedProjectSession | null {
  if (!isRecord(value)) return null
  const tabs = Array.isArray(value.tabs)
    ? value.tabs.map(parseEditorTab).filter((t): t is PersistedEditorTab => t != null)
    : []
  const terminals = Array.isArray(value.terminals)
    ? value.terminals.map(parseTerminal).filter((t): t is PersistedTerminalMeta => t != null)
    : []
  const activeTabId =
    typeof value.activeTabId === 'string'
      ? value.activeTabId
      : value.activeTabId === null
        ? null
        : tabs[0]?.id ?? null
  const activeTerminalId =
    typeof value.activeTerminalId === 'string'
      ? value.activeTerminalId
      : value.activeTerminalId === null
        ? null
        : terminals[0]?.id ?? null
  return {
    tabs,
    activeTabId:
      activeTabId && tabs.some(t => t.id === activeTabId) ? activeTabId : tabs[0]?.id ?? null,
    terminals,
    activeTerminalId:
      activeTerminalId && terminals.some(t => t.id === activeTerminalId)
        ? activeTerminalId
        : terminals[0]?.id ?? null,
  }
}

/** Parse and normalize a raw JSON value; returns null when unusable. */
export function parseWorkspaceSession(raw: unknown): WorkspaceSessionSnapshot | null {
  if (!isRecord(raw)) return null
  if (raw.version !== WORKSPACE_SESSION_VERSION) return null
  if (!isRecord(raw.projects)) return null
  const projects: Record<string, PersistedProjectSession> = {}
  for (const [projectId, session] of Object.entries(raw.projects)) {
    if (!projectId) continue
    const parsed = parseProjectSession(session)
    if (!parsed) continue
    if (parsed.tabs.length === 0 && parsed.terminals.length === 0) continue
    projects[projectId] = parsed
  }
  const pinnedTabs = Array.isArray(raw.pinnedTabs)
    ? raw.pinnedTabs.map(parseEditorTab).filter((t): t is PersistedEditorTab => t != null)
    : []
  if (Object.keys(projects).length === 0 && pinnedTabs.length === 0) {
    return {
      version: WORKSPACE_SESSION_VERSION,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      projects: {},
    }
  }
  return {
    version: WORKSPACE_SESSION_VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    ...(pinnedTabs.length > 0 ? { pinnedTabs } : {}),
    projects,
  }
}

export function loadWorkspaceSession(): WorkspaceSessionSnapshot | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_SESSION_KEY)
    if (!raw) return null
    return parseWorkspaceSession(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function saveWorkspaceSession(snapshot: WorkspaceSessionSnapshot): void {
  try {
    localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(snapshot))
  } catch {
    // Quota / private mode — session restore simply will not persist.
  }
}

export function clearWorkspaceSession(): void {
  try {
    localStorage.removeItem(WORKSPACE_SESSION_KEY)
  } catch {
    /* ignore */
  }
}

export function serializeEditorTab(tab: EditorTabSnapshotInput): PersistedEditorTab {
  const out: PersistedEditorTab = {
    id: tab.id,
    path: tab.path,
    name: tab.name,
    dirty: tab.dirty === true,
  }
  if (tab.language) out.language = tab.language
  if (tab.scroll && Number.isFinite(tab.scroll.top) && Number.isFinite(tab.scroll.left)) {
    out.scroll = { top: tab.scroll.top, left: tab.scroll.left }
  }
  if (tab.viewMode === 'view') out.viewMode = 'view'
  return out
}

export function serializeTerminalMeta(terminal: TerminalSnapshotInput): PersistedTerminalMeta {
  const out: PersistedTerminalMeta = {
    id: terminal.id,
    name: terminal.name,
    cwd: terminal.cwd,
    launchCommand: terminal.launchCommand,
  }
  if (terminal.shellKind) out.shellKind = terminal.shellKind
  if (terminal.env && Object.keys(terminal.env).length > 0) out.env = { ...terminal.env }
  if (terminal.profileId) out.profileId = terminal.profileId
  if (typeof terminal.allowTitleRename === 'boolean') {
    out.allowTitleRename = terminal.allowTitleRename
  }
  return out
}

/** Build a durable snapshot from in-memory editor + terminal state. */
export function buildWorkspaceSessionSnapshot(input: {
  editorSessions: Record<string, ProjectEditorSessionInput>
  terminals: TerminalSnapshotInput[]
  activeTerminalByProject: Record<string, string>
  /** Global pinned settings tabs (survive project switches and restarts). */
  pinnedTabs?: EditorTabSnapshotInput[]
  /** Project ids that must not be written (e.g. ephemeral). */
  excludeProjectIds?: Iterable<string>
  now?: number
}): WorkspaceSessionSnapshot {
  const exclude = new Set(input.excludeProjectIds ?? [])
  const terminalsByProject = new Map<string, PersistedTerminalMeta[]>()
  for (const terminal of input.terminals) {
    if (exclude.has(terminal.projectId)) continue
    const list = terminalsByProject.get(terminal.projectId) ?? []
    list.push(serializeTerminalMeta(terminal))
    terminalsByProject.set(terminal.projectId, list)
  }

  const projectIds = new Set<string>([
    ...Object.keys(input.editorSessions),
    ...terminalsByProject.keys(),
  ])

  const projects: Record<string, PersistedProjectSession> = {}
  for (const projectId of projectIds) {
    if (exclude.has(projectId)) continue
    const editor = input.editorSessions[projectId]
    const tabs = (editor?.tabs ?? []).map(serializeEditorTab)
    const terminals = terminalsByProject.get(projectId) ?? []
    if (tabs.length === 0 && terminals.length === 0) continue
    const activeTabId =
      editor?.activeTabId && tabs.some(t => t.id === editor.activeTabId)
        ? editor.activeTabId
        : tabs[0]?.id ?? null
    const remembered = input.activeTerminalByProject[projectId]
    const activeTerminalId =
      remembered && terminals.some(t => t.id === remembered)
        ? remembered
        : terminals[0]?.id ?? null
    projects[projectId] = { tabs, activeTabId, terminals, activeTerminalId }
  }

  const pinnedTabs = (input.pinnedTabs ?? []).map(serializeEditorTab)

  return {
    version: WORKSPACE_SESSION_VERSION,
    updatedAt: input.now ?? Date.now(),
    ...(pinnedTabs.length > 0 ? { pinnedTabs } : {}),
    projects,
  }
}

/** Paths of every editor tab recorded in the snapshot (for draft coordination). */
export function collectPersistedTabPaths(snapshot: WorkspaceSessionSnapshot): string[] {
  const paths: string[] = []
  for (const tab of snapshot.pinnedTabs ?? []) paths.push(tab.path)
  for (const session of Object.values(snapshot.projects)) {
    for (const tab of session.tabs) paths.push(tab.path)
  }
  return paths
}
