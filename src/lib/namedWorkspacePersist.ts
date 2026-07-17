/**
 * Named multi-project workspaces: a saved group of projects plus their
 * editor/terminal session snapshots. Distinct from the auto-persisted
 * `qingcode:workspace-sessions` blob (see workspaceSessionPersist).
 */

import { pathsEqual } from '../utils/fileReferences'
import {
  WORKSPACE_SESSION_VERSION,
  parseProjectSession,
  type PersistedEditorTab,
  type PersistedProjectSession,
  type WorkspaceSessionSnapshot,
} from './workspaceSessionPersist'

export const NAMED_WORKSPACES_KEY = 'qingcode:named-workspaces'
export const NAMED_WORKSPACE_VERSION = 1 as const

export type WorkspaceMember = {
  projectId: string
  path: string
  name: string
}

export type NamedWorkspace = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  members: WorkspaceMember[]
  /** Project that was active when the workspace was saved (member id). */
  activeProjectId: string | null
  /** Per-member sessions keyed by the member's projectId at save time. */
  sessions: Record<string, PersistedProjectSession>
  pinnedTabs?: PersistedEditorTab[]
}

export type NamedWorkspaceCatalog = {
  version: typeof NAMED_WORKSPACE_VERSION
  updatedAt: number
  workspaces: NamedWorkspace[]
  /** Last activated workspace (UI highlight); null if none / cleared. */
  activeWorkspaceId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMember(value: unknown): WorkspaceMember | null {
  if (!isRecord(value)) return null
  if (typeof value.projectId !== 'string' || !value.projectId) return null
  if (typeof value.path !== 'string' || !value.path) return null
  const name = typeof value.name === 'string' ? value.name : value.path
  return { projectId: value.projectId, path: value.path, name }
}

function parseEditorTabLoose(value: unknown): PersistedEditorTab | null {
  // Reuse project-session parser via a one-tab wrapper.
  const session = parseProjectSession({
    tabs: [value],
    terminals: [],
    activeTabId: null,
    activeTerminalId: null,
  })
  return session?.tabs[0] ?? null
}

/** Parse and normalize a raw named-workspace value. */
export function parseNamedWorkspace(raw: unknown): NamedWorkspace | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null
  if (!Array.isArray(raw.members)) return null

  const members = raw.members
    .map(parseMember)
    .filter((m): m is WorkspaceMember => m != null)
  if (members.length === 0) return null

  const memberIds = new Set(members.map(m => m.projectId))
  const sessions: Record<string, PersistedProjectSession> = {}
  if (isRecord(raw.sessions)) {
    for (const [projectId, session] of Object.entries(raw.sessions)) {
      if (!memberIds.has(projectId)) continue
      const parsed = parseProjectSession(session)
      if (parsed) sessions[projectId] = parsed
    }
  }

  const pinnedTabs = Array.isArray(raw.pinnedTabs)
    ? raw.pinnedTabs.map(parseEditorTabLoose).filter((t): t is PersistedEditorTab => t != null)
    : []

  const activeProjectId =
    typeof raw.activeProjectId === 'string' && memberIds.has(raw.activeProjectId)
      ? raw.activeProjectId
      : members[0]?.projectId ?? null

  return {
    id: raw.id,
    name: raw.name.trim(),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    members,
    activeProjectId,
    sessions,
    ...(pinnedTabs.length > 0 ? { pinnedTabs } : {}),
  }
}

export function parseNamedWorkspaceCatalog(raw: unknown): NamedWorkspaceCatalog | null {
  if (!isRecord(raw)) return null
  if (raw.version !== NAMED_WORKSPACE_VERSION) return null
  if (!Array.isArray(raw.workspaces)) return null
  const workspaces = raw.workspaces
    .map(parseNamedWorkspace)
    .filter((w): w is NamedWorkspace => w != null)
  const activeWorkspaceId =
    typeof raw.activeWorkspaceId === 'string' &&
    workspaces.some(w => w.id === raw.activeWorkspaceId)
      ? raw.activeWorkspaceId
      : null
  return {
    version: NAMED_WORKSPACE_VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    workspaces,
    activeWorkspaceId,
  }
}

export function emptyNamedWorkspaceCatalog(now = Date.now()): NamedWorkspaceCatalog {
  return {
    version: NAMED_WORKSPACE_VERSION,
    updatedAt: now,
    workspaces: [],
    activeWorkspaceId: null,
  }
}

export function loadNamedWorkspaceCatalog(): NamedWorkspaceCatalog {
  try {
    const raw = localStorage.getItem(NAMED_WORKSPACES_KEY)
    if (!raw) return emptyNamedWorkspaceCatalog()
    return parseNamedWorkspaceCatalog(JSON.parse(raw) as unknown) ?? emptyNamedWorkspaceCatalog()
  } catch {
    return emptyNamedWorkspaceCatalog()
  }
}

export function saveNamedWorkspaceCatalog(catalog: NamedWorkspaceCatalog): void {
  try {
    localStorage.setItem(NAMED_WORKSPACES_KEY, JSON.stringify(catalog))
  } catch {
    // Quota / private mode — named workspaces simply will not persist.
  }
}

export function clearNamedWorkspaceCatalog(): void {
  try {
    localStorage.removeItem(NAMED_WORKSPACES_KEY)
  } catch {
    /* ignore */
  }
}

export type ProjectLike = {
  id: string
  path: string
  name: string
  hidden?: number | boolean
  ephemeral?: boolean
}

/** Match a saved member to a live project (id first, then path). */
export function resolveWorkspaceMember(
  member: WorkspaceMember,
  projects: ProjectLike[],
): ProjectLike | undefined {
  const byId = projects.find(p => p.id === member.projectId)
  if (byId) return byId
  return projects.find(p => pathsEqual(p.path, member.path))
}

/**
 * Build a named workspace from a live project list + a session snapshot
 * (typically from `captureWorkspaceSessionSnapshot`).
 */
export function buildNamedWorkspace(input: {
  id?: string
  name: string
  projects: ProjectLike[]
  snapshot: WorkspaceSessionSnapshot
  activeProjectId?: string | null
  now?: number
}): NamedWorkspace | null {
  const durable = input.projects.filter(p => !p.ephemeral)
  if (durable.length === 0) return null
  const now = input.now ?? Date.now()
  const members: WorkspaceMember[] = durable.map(p => ({
    projectId: p.id,
    path: p.path,
    name: p.name,
  }))
  const memberIds = new Set(members.map(m => m.projectId))
  const sessions: Record<string, PersistedProjectSession> = {}
  for (const [projectId, session] of Object.entries(input.snapshot.projects)) {
    if (!memberIds.has(projectId)) continue
    sessions[projectId] = session
  }
  const activeProjectId =
    input.activeProjectId && memberIds.has(input.activeProjectId)
      ? input.activeProjectId
      : members[0]?.projectId ?? null
  const pinnedTabs = input.snapshot.pinnedTabs

  return {
    id: input.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    createdAt: now,
    updatedAt: now,
    members,
    activeProjectId,
    sessions,
    ...(pinnedTabs && pinnedTabs.length > 0 ? { pinnedTabs } : {}),
  }
}

/** Remap saved sessions onto current project ids (when path match remapped the id). */
export function remapWorkspaceSessions(
  workspace: NamedWorkspace,
  projects: ProjectLike[],
): {
  resolved: Array<{ member: WorkspaceMember; project: ProjectLike }>
  sessionsByProjectId: Record<string, PersistedProjectSession>
  activeProjectId: string | null
  missing: WorkspaceMember[]
} {
  const resolved: Array<{ member: WorkspaceMember; project: ProjectLike }> = []
  const missing: WorkspaceMember[] = []
  const sessionsByProjectId: Record<string, PersistedProjectSession> = {}

  for (const member of workspace.members) {
    const project = resolveWorkspaceMember(member, projects)
    if (!project || project.ephemeral) {
      missing.push(member)
      continue
    }
    resolved.push({ member, project })
    const session = workspace.sessions[member.projectId]
    if (session) sessionsByProjectId[project.id] = session
  }

  let activeProjectId: string | null = null
  if (workspace.activeProjectId) {
    const activeMember = workspace.members.find(m => m.projectId === workspace.activeProjectId)
    if (activeMember) {
      const project = resolveWorkspaceMember(activeMember, projects)
      if (project && !project.ephemeral) activeProjectId = project.id
    }
  }
  if (!activeProjectId) activeProjectId = resolved[0]?.project.id ?? null

  return { resolved, sessionsByProjectId, activeProjectId, missing }
}

/** Catalog upsert helpers (pure). */
export function upsertNamedWorkspace(
  catalog: NamedWorkspaceCatalog,
  workspace: NamedWorkspace,
  now = Date.now(),
): NamedWorkspaceCatalog {
  const idx = catalog.workspaces.findIndex(w => w.id === workspace.id)
  const workspaces = [...catalog.workspaces]
  if (idx >= 0) workspaces[idx] = { ...workspace, updatedAt: now }
  else workspaces.unshift(workspace)
  return {
    ...catalog,
    updatedAt: now,
    workspaces,
  }
}

export function removeNamedWorkspace(
  catalog: NamedWorkspaceCatalog,
  id: string,
  now = Date.now(),
): NamedWorkspaceCatalog {
  return {
    ...catalog,
    updatedAt: now,
    workspaces: catalog.workspaces.filter(w => w.id !== id),
    activeWorkspaceId: catalog.activeWorkspaceId === id ? null : catalog.activeWorkspaceId,
  }
}

export function setActiveNamedWorkspaceId(
  catalog: NamedWorkspaceCatalog,
  id: string | null,
  now = Date.now(),
): NamedWorkspaceCatalog {
  if (id && !catalog.workspaces.some(w => w.id === id)) {
    return { ...catalog, updatedAt: now, activeWorkspaceId: null }
  }
  return { ...catalog, updatedAt: now, activeWorkspaceId: id }
}

/** Sanity: snapshot version we embed is the same as auto-session. */
export const EMBEDDED_SESSION_VERSION = WORKSPACE_SESSION_VERSION
