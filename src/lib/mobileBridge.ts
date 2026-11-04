import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useProjectStore } from '@/store/projectStore'
import type { Project, SshConnection } from '@/types'
import { listProjects, listSshConnections, withDb } from './projectRepository'
import { ensureSshWorkspaceConnected, isSshProject, sshConnectionIdFromUri } from './sshWorkspace'
import { isTauri, safeInvoke } from './tauri'
import { isWslProject, wslDistroNameFromPath } from './wslWorkspace'
import { isProjectTrusted, pushTrustedRootsToNative } from './workspaceTrust'

interface Request {
  id: string
  project: string | null
}

function mobileProject(project: Project, connections: Map<string, Pick<SshConnection, 'name' | 'host'>>) {
  const kind = isSshProject(project) ? 'ssh' : isWslProject(project) ? 'wsl' : 'local'
  const connection = project.connection_id || sshConnectionIdFromUri(project.path)
  const remote = kind === 'ssh' ? connections.get(connection ?? '') : undefined
  const host = kind === 'ssh'
    ? remote?.host ?? 'SSH'
    : kind === 'wsl' ? wslDistroNameFromPath(project.path) ?? 'WSL' : 'Windows'
  return { id: project.id, name: project.name, path: project.path, kind, host, connectionName: remote?.name }
}

async function respond(projectId: string | null) {
  // The main window can lag behind projects added/removed in another window or
  // through the CLI. Mobile refresh and terminal creation both need saved state.
  const projects = await withDb('加载移动端项目列表', listProjects)
  const trusted = projects.filter(project => !project.ephemeral && isProjectTrusted(project))
  if (projectId !== null) {
    const project = trusted.find(item => item.id === projectId)
    if (!project) throw new Error('请在 Windows QingCode 中信任该项目后重试。')
    const ephemeral = useProjectStore.getState().projects.filter(project => project.ephemeral)
    await pushTrustedRootsToNative([...projects, ...ephemeral])
    await ensureSshWorkspaceConnected(project)
    const connections = await listSshConnections()
    return mobileProject(project, new Map(connections.map(connection => [connection.id, connection])))
  }
  const connections = await listSshConnections()
  const hosts = new Map(connections.map(connection => [connection.id, connection]))
  return trusted.map(project => mobileProject(project, hosts))
}

export async function listenForMobileRequests(): Promise<() => void> {
  if (!isTauri() || getCurrentWebviewWindow().label !== 'main') return () => {}
  return listen<Request>('mobile-request', async ({ payload }) => {
    const result = await respond(payload.project).then(
      data => ({ data }),
      error => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    await safeInvoke('回复移动端请求', 'mobile_bridge_reply', { id: payload.id, ...result })
      .catch(error => console.warn('Mobile bridge reply failed', error))
  })
}
