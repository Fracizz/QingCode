/**
 * Wire durable workspace sessions into editor/terminal stores.
 *
 * Hydrate once at boot (main window only). Persist on changes with debounce.
 * Fresh windows (`?fresh=1`) neither hydrate nor overwrite shared localStorage.
 */

import {
  buildWorkspaceSessionSnapshot,
  loadWorkspaceSession,
  saveWorkspaceSession,
  type WorkspaceSessionSnapshot,
} from './workspaceSessionPersist'
import {
  flushAllLiveEditorContents,
  getEditorScroll,
  setEditorScroll,
  type EditorScrollPos,
} from './editorSession'
import { shouldRestoreWorkspace } from './windowSession'
import { isSessionPersistEnabled } from './sessionPersistSettings'
import { isPinnedSettingsTab } from '../utils/editorHelpers'
import { useEditorStore, type ProjectEditorSession } from '../store/editorStore'
import { persistTerminalOutputNow, useTerminalStore } from '../store/terminalStore'
import { rehydrateRunningFromTerminals } from '../store/runConfigStore'
import { useProjectStore } from '../store/projectStore'
import type { EditorTab, TerminalTab } from '../types'
import {
  projectSessionFromPersisted,
  tabFromPersisted,
  terminalFromPersisted,
} from './workspaceSessionRestore'

export {
  projectSessionFromPersisted,
  tabFromPersisted,
  terminalFromPersisted,
} from './workspaceSessionRestore'

const PERSIST_DEBOUNCE_MS = 400

let installed = false
let hydrated = false
/** False until project list has loaded — avoids writing an empty snapshot over storage. */
let persistReady = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
let unsubEditor: (() => void) | null = null
let unsubTerminal: (() => void) | null = null
let unsubProject: (() => void) | null = null

function splitPinned(tabs: EditorTab[]) {
  const pinned: EditorTab[] = []
  const projectTabs: EditorTab[] = []
  for (const tab of tabs) {
    if (isPinnedSettingsTab(tab.path)) pinned.push(tab)
    else projectTabs.push(tab)
  }
  return { pinned, projectTabs }
}

function applyScrollHints(snapshot: WorkspaceSessionSnapshot) {
  for (const tab of snapshot.pinnedTabs ?? []) {
    if (!tab.scroll) continue
    setEditorScroll(tab.id, tab.scroll)
  }
  for (const session of Object.values(snapshot.projects)) {
    for (const tab of session.tabs) {
      if (!tab.scroll) continue
      setEditorScroll(tab.id, tab.scroll)
    }
  }
}

/** Seed editor `projectSessions` + terminal metadata before React / loadProjects. */
export function hydrateWorkspaceSessionsIfNeeded(): boolean {
  if (hydrated) return false
  hydrated = true
  if (!shouldRestoreWorkspace()) return false
  if (!isSessionPersistEnabled()) return false

  const snapshot = loadWorkspaceSession()
  if (!snapshot) return false

  const pinnedTabs = (snapshot.pinnedTabs ?? [])
    .filter(t => isPinnedSettingsTab(t.path))
    .map(tabFromPersisted)
  if (Object.keys(snapshot.projects).length === 0 && pinnedTabs.length === 0) return false

  const projectSessions: Record<string, ProjectEditorSession> = {}
  const terminals: TerminalTab[] = []
  const activeTerminalByProject: Record<string, string> = {}

  for (const [projectId, session] of Object.entries(snapshot.projects)) {
    projectSessions[projectId] = projectSessionFromPersisted(session)
    for (const terminal of session.terminals) {
      terminals.push(terminalFromPersisted(projectId, terminal))
    }
    if (session.activeTerminalId) {
      activeTerminalByProject[projectId] = session.activeTerminalId
    }
  }

  applyScrollHints(snapshot)

  // Pinned settings tabs live in the visible `tabs` array so the first
  // `activateProjectSession` (on restore) keeps them across project switches.
  useEditorStore.setState({
    projectSessions,
    tabs: pinnedTabs,
    activeTabId: pinnedTabs[0]?.id ?? null,
  })
  useTerminalStore.getState().hydrateTerminalSessions(terminals, activeTerminalByProject)
  rehydrateRunningFromTerminals()
  return true
}

function collectEditorSessionsForPersist(): Record<
  string,
  { tabs: EditorTab[]; activeTabId: string | null }
> {
  flushAllLiveEditorContents()
  const editor = useEditorStore.getState()
  const currentId = useProjectStore.getState().currentProject?.id ?? null
  const sessions: Record<string, { tabs: EditorTab[]; activeTabId: string | null }> = {}

  for (const [projectId, session] of Object.entries(editor.projectSessions)) {
    sessions[projectId] = {
      tabs: session.tabs.filter(t => !isPinnedSettingsTab(t.path)),
      activeTabId: session.activeTabId,
    }
  }

  if (currentId) {
    const { projectTabs } = splitPinned(editor.tabs)
    const activeInProject =
      editor.activeTabId && projectTabs.some(t => t.id === editor.activeTabId)
        ? editor.activeTabId
        : projectTabs[0]?.id ?? null
    sessions[currentId] = { tabs: projectTabs, activeTabId: activeInProject }
  }

  return sessions
}

function scrollForTab(tabId: string): EditorScrollPos | null {
  return getEditorScroll(tabId) ?? null
}

/** Drop in-memory sessions for project ids that no longer exist. */
export function pruneWorkspaceSessions(knownProjectIds: Iterable<string>) {
  const known = new Set(knownProjectIds)
  const editor = useEditorStore.getState()
  let changed = false
  const projectSessions = { ...editor.projectSessions }
  for (const id of Object.keys(projectSessions)) {
    if (known.has(id)) continue
    delete projectSessions[id]
    changed = true
  }
  if (changed) useEditorStore.setState({ projectSessions })

  const terminalState = useTerminalStore.getState()
  const terminals = terminalState.terminals.filter(t => known.has(t.projectId))
  if (terminals.length !== terminalState.terminals.length) {
    const activeTerminalByProject = { ...terminalState.activeTerminalByProject }
    for (const id of Object.keys(activeTerminalByProject)) {
      if (!known.has(id)) delete activeTerminalByProject[id]
    }
    useTerminalStore.setState({
      terminals,
      activeTerminalByProject,
      activeTerminalId: terminals.some(t => t.id === terminalState.activeTerminalId)
        ? terminalState.activeTerminalId
        : null,
    })
  }
}

/** Call after the first `loadProjects` settles so we do not clobber storage. */
export function markWorkspaceSessionPersistReady() {
  if (persistReady) return
  persistReady = true
  scheduleWorkspaceSessionPersist()
}

/**
 * Capture the current in-memory editor + terminal session.
 * Optionally restrict to a set of durable project ids (named workspaces).
 */
export function captureWorkspaceSessionSnapshot(options?: {
  /** When set, only these durable project ids are included. */
  projectIds?: Iterable<string>
  now?: number
}): WorkspaceSessionSnapshot {
  const projectState = useProjectStore.getState()
  const durableIds = new Set(
    projectState.projects.filter(p => !p.ephemeral).map(p => p.id),
  )
  const filterIds = options?.projectIds ? new Set(options.projectIds) : null
  const includeIds = filterIds
    ? new Set([...filterIds].filter(id => durableIds.has(id)))
    : durableIds

  const ephemeralIds = projectState.projects.filter(p => p.ephemeral).map(p => p.id)
  // Also exclude sessions whose project was removed while the app was closed.
  const unknownIds = Object.keys(useEditorStore.getState().projectSessions).filter(
    id => !durableIds.has(id) && !ephemeralIds.includes(id),
  )
  const editorSessions = collectEditorSessionsForPersist()
  const terminalState = useTerminalStore.getState()
  const { pinned: pinnedTabs } = splitPinned(useEditorStore.getState().tabs)

  return buildWorkspaceSessionSnapshot({
    editorSessions: Object.fromEntries(
      Object.entries(editorSessions)
        .filter(([projectId]) => includeIds.has(projectId))
        .map(([projectId, session]) => [
          projectId,
          {
            tabs: session.tabs.map(tab => ({
              id: tab.id,
              path: tab.path,
              name: tab.name,
              dirty: tab.viewMode === 'view' ? false : tab.dirty,
              language: tab.language,
              scroll: scrollForTab(tab.id),
              viewMode: tab.viewMode,
            })),
            activeTabId: session.activeTabId,
          },
        ]),
    ),
    pinnedTabs: pinnedTabs.map(tab => ({
      id: tab.id,
      path: tab.path,
      name: tab.name,
      dirty: tab.viewMode === 'view' ? false : tab.dirty,
      language: tab.language,
      scroll: scrollForTab(tab.id),
      viewMode: tab.viewMode,
    })),
    terminals: terminalState.terminals
      .filter(t => includeIds.has(t.projectId))
      .map(t => ({
        id: t.id,
        name: t.name,
        projectId: t.projectId,
        cwd: t.cwd,
        launchCommand: t.launchCommand,
        shell: t.shell,
        shellKind: t.shellKind,
        env: t.env,
        profileId: t.profileId,
        allowTitleRename: t.allowTitleRename,
        runConfigId: t.runConfigId,
        runTaskId: t.runTaskId,
      })),
    activeTerminalByProject: terminalState.activeTerminalByProject,
    excludeProjectIds: [...ephemeralIds, ...unknownIds],
    now: options?.now,
  })
}

function persistNow() {
  if (!shouldRestoreWorkspace() || !persistReady) return
  if (!isSessionPersistEnabled()) return
  saveWorkspaceSession(captureWorkspaceSessionSnapshot())
  // Keep bulky scrollback in sync when session metadata flushes.
  persistTerminalOutputNow()
}

export function scheduleWorkspaceSessionPersist() {
  if (!shouldRestoreWorkspace()) return
  if (!isSessionPersistEnabled()) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, PERSIST_DEBOUNCE_MS)
}

/** Subscribe stores so session changes survive restart (main window only). */
export function installWorkspaceSessionPersistence() {
  if (installed) return
  installed = true
  if (!shouldRestoreWorkspace()) return

  unsubEditor = useEditorStore.subscribe(() => scheduleWorkspaceSessionPersist())
  unsubTerminal = useTerminalStore.subscribe(() => scheduleWorkspaceSessionPersist())
  unsubProject = useProjectStore.subscribe((state, prev) => {
    if (state.currentProject?.id !== prev.currentProject?.id) {
      scheduleWorkspaceSessionPersist()
    }
  })

  window.addEventListener('beforeunload', persistNow)
}

export function flushWorkspaceSessionPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persistNow()
}

/** Test helper — reset module flags between Vitest cases. */
export function _resetWorkspaceSessionSyncForTests() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  unsubEditor?.()
  unsubTerminal?.()
  unsubProject?.()
  unsubEditor = null
  unsubTerminal = null
  unsubProject = null
  installed = false
  hydrated = false
  persistReady = false
}
