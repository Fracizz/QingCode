import { create } from 'zustand'
import type { Project, SshConnection, TerminalTab } from '../types'
import type { Toast } from '../store/projectStore'
import { projectManagerFixtures } from './projectManagerFixtures'

type Operation = { action: string; ids: string[] }
export const useWebTestOperations = create<{ operations: Operation[] }>(() => ({ operations: [] }))

function record(action: string, ids: string[] = []) {
  useWebTestOperations.setState(state => ({ operations: [...state.operations, { action, ids }] }))
}

const fixtures = projectManagerFixtures()
export const useProjectStore = create(() => ({
  ...fixtures,
  currentProject: fixtures.projects.find(project => project.id === 'wsl-nem') ?? null,
  unavailableProjectIds: [] as string[],
  toasts: [] as Toast[],
  pauseToast() { /* Fixture notifications remain visible until explicitly dismissed. */ },
  resumeToast() { /* No real timers in browser fixtures. */ },
  dismissToast(id: string) {
    useProjectStore.setState(state => ({ toasts: state.toasts.filter(toast => toast.id !== id) }))
  },
  async loadSshConnections() { /* Fixed in-memory fixture. */ },
  async deleteSshConnection(id: string) {
    record('deleteSshConnection', [id])
    useProjectStore.setState(state => ({ sshConnections: state.sshConnections.filter(connection => connection.id !== id) }))
  },
  async saveSshConnection(connection: SshConnection) {
    record('saveSshConnection', [connection.id])
    useProjectStore.setState(state => ({
      sshConnections: [...state.sshConnections.filter(item => item.id !== connection.id), connection],
    }))
  },
  async switchProject(project: Project) {
    record('switchProject', [project.id])
    useProjectStore.setState({ currentProject: project })
    return true
  },
  async hideProject(id: string) {
    record('hideProject', [id])
    setHidden(id, 1)
  },
  async unhideProject(id: string) {
    record('unhideProject', [id])
    setHidden(id, 0)
  },
  async removeProject(id: string) {
    record('removeProject', [id])
    useProjectStore.setState(state => ({
      projects: state.projects.filter(project => project.id !== id),
    }))
  },
  pushToast(_kind: string, text: string) {
    record(text)
  },
}))

function setHidden(id: string, hidden: number) {
  useProjectStore.setState(state => ({
    projects: state.projects.map(project => (project.id === id ? { ...project, hidden } : project)),
  }))
}

export const useUIStore = create(() => ({
  serverUpdateRootUri: null as string | null,
  projectManagerOpen: true,
  remoteConnectionsOpen: true,
  remoteConnectionsCreating: false,
  terminalManagerOpen: false,
  closeTerminalManager() { useUIStore.setState({ terminalManagerOpen: false }) },
  openTerminalManager() { useUIStore.setState({ terminalManagerOpen: true }) },
  openTerminalPanel() { record('openTerminalPanel') },
  closeRemoteConnections() { useUIStore.setState({ remoteConnectionsOpen: false }) },
  requestSettings(query: string) { record('requestSettings', [query]) },
  closeProjectManager() {
    useUIStore.setState({ projectManagerOpen: false })
  },
  openProjectManager() {
    useUIStore.setState({ projectManagerOpen: true })
  },
  openCreateProject() {
    record('openCreateProject')
  },
  openWorkspaceManager() {
    record('openWorkspaceManager')
  },
}))

export const useTerminalStore = create(() => ({
  terminals: [] as TerminalTab[],
  async closeTerminal(id: string) {
    record('closeTerminal', [id])
    if (useTerminalManagerFixture.getState().failedIds.includes(id)) return
    useTerminalStore.setState(state => ({ terminals: state.terminals.filter(tab => tab.id !== id) }))
  },
  setActiveTerminal(id: string) { record('setActiveTerminal', [id]) },
  renameTerminal(id: string, name: string) {
    useTerminalStore.setState(state => ({
      terminals: state.terminals.map(tab => tab.id === id ? { ...tab, name } : tab),
    }))
  },
  async closeProjectTerminals(id: string) {
    record('closeProjectTerminals', [id])
  },
}))
export const useTerminalManagerFixture = create(() => ({ failedIds: [] as string[] }))

export async function openMobileSessionTab(session: { id: string }) {
  record('openMobileSessionTab', [session.id])
  return useTerminalStore.getState().terminals.find(tab => tab.id === session.id)
}

export function resetTerminalManagerFixture(count = 65) {
  useWebTestOperations.setState({ operations: [] })
  useTerminalManagerFixture.setState({ failedIds: [] })
  useTerminalStore.setState({ terminals: Array.from({ length: count }, (_, index): TerminalTab => ({
    id: `fixture-terminal-${index + 1}`,
    name: `Fixture ${String(index + 1).padStart(2, '0')} ${index % 5 === 0 ? 'finished' : 'worker'}`,
    projectId: index < 40 ? 'local-qingcode' : 'ubuntu-django',
    cwd: index < 40 ? 'D:/fixtures/QingCode' : '/home/code/django',
    launchCommand: '',
    status: index % 5 === 0 ? 'exited' : 'running',
    exitCode: index % 5 === 0 ? 0 : null,
  })) })
  useUIStore.setState({ terminalManagerOpen: true })
}
export const useEditorStore = create(() => ({
  closeTabsForPath(path: string) {
    record('closeTabsForPath', [path])
  },
  discardProjectSession(id: string) {
    record('discardProjectSession', [id])
  },
}))

export const WORKSPACE_TRUST_CHANGED_EVENT = 'qingcode:web-test-trust-changed'
export function normalizeProjectPath(path: string) {
  const value = path.trim().replace(/[/\\]+$/, '').replace(/\\/g, '/')
  return value.startsWith('ssh://') ? value : value.toLowerCase()
}
const trust = new Map<string, 'trusted' | 'restricted'>()
export function getWorkspaceTrust(project: Project) {
  return trust.get(project.id) ?? 'undecided'
}
export function isProjectTrusted(project: Project) {
  return getWorkspaceTrust(project) === 'trusted'
}
export function createProjectTrustChecker() {
  return isProjectTrusted
}
function setTrust(project: Project, level?: 'trusted' | 'restricted') {
  if (level) trust.set(project.id, level)
  else trust.delete(project.id)
  window.dispatchEvent(new Event(WORKSPACE_TRUST_CHANGED_EVENT))
}
export function restrictProject(project: Project) {
  setTrust(project, 'restricted')
}
export function trustProject(project: Project) {
  setTrust(project, 'trusted')
}
export function untrustProject(project: Project) {
  setTrust(project)
}
export async function pushTrustedRootsToNative() {
  /* Deliberately memory-only. */
}

export async function saveSelectedProjectsAsWorkspace(ids: string[]) {
  record('saveWorkspace', ids)
}
export async function removeProjectWithConfirm(id: string) {
  record('requestRemoveProject', [id])
}
export async function relocateProjectWithDialog(id: string) {
  record('relocateProject', [id])
}
export async function renameProjectWithPrompt(id: string) {
  record('renameProject', [id])
}
export async function addTerminalProjectWithPrompt() {
  record('addScratchProject')
}

export function resetProjectManagerFixture() {
  const next = projectManagerFixtures()
  trust.clear()
  useWebTestOperations.setState({ operations: [] })
  useProjectStore.setState({
    ...next,
    currentProject: next.projects.find(project => project.id === 'wsl-nem') ?? null,
  })
  useUIStore.setState({ projectManagerOpen: true })
}
