import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useProjectStore } from '@/store/projectStore'
import type { Project } from '@/types'
import { listSshConnections } from './projectRepository'
import { ensureSshWorkspaceConnected, isSshProject, sshConnectionIdFromUri } from './sshWorkspace'
import { isTauri, safeInvoke } from './tauri'
import { isWslProject, wslDistroNameFromPath } from './wslWorkspace'
import { isProjectTrusted, pushTrustedRootsToNative } from './workspaceTrust'

interface Request {
  id: string
  project: string | null
}

function mobileProject(project: Project, hosts: Map<string, string>) {
  const kind = isSshProject(project) ? 'ssh' : isWslProject(project) ? 'wsl' : 'local'
  const connection = project.connection_id || sshConnectionIdFromUri(project.path)
  const host = kind === 'ssh'
    ? hosts.get(connection ?? '') ?? 'SSH'
    : kind === 'wsl' ? wslDistroNameFromPath(project.path) ?? 'WSL' : 'Windows'
  return { id: project.id, name: project.name, path: project.path, kind, host }
}

async function respond(projectId: string | null) {
  const { projects } = useProjectStore.getState()
  const trusted = projects.filter(project => !project.ephemeral && isProjectTrusted(project))
  if (projectId !== null) {
    const project = trusted.find(item => item.id === projectId)
    if (!project) throw new Error('请在 Windows QingCode 中信任该项目后重试。')
    await pushTrustedRootsToNative(projects)
    await ensureSshWorkspaceConnected(project)
    return mobileProject(project, new Map())
  }
  const connections = await listSshConnections()
  const hosts = new Map(connections.map(connection => [connection.id, connection.host]))
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
