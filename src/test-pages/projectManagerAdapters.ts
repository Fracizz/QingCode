import { create } from 'zustand'
import type { Project, SshConnection } from '../types'
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
  toasts: [],
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
  projectManagerOpen: true,
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
  async closeProjectTerminals(id: string) {
    record('closeProjectTerminals', [id])
  },
}))
export const useEditorStore = create(() => ({
  closeTabsForPath(path: string) {
    record('closeTabsForPath', [path])
  },
  discardProjectSession(id: string) {
    record('discardProjectSession', [id])
  },
}))

export const WORKSPACE_TRUST_CHANGED_EVENT = 'qingcode:web-test-trust-changed'
const trust = new Map<string, 'trusted' | 'restricted'>()
export function getWorkspaceTrust(project: Project) {
  return trust.get(project.id) ?? 'undecided'
}
export function isProjectTrusted(project: Project) {
  return getWorkspaceTrust(project) === 'trusted'
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
