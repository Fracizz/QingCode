import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useProjectStore } from '@/store/projectStore'
import type { Project, SshConnection } from '@/types'
import { listProjects, listSshConnections, withDb } from './projectRepository'
import { ensureSshWorkspaceConnected, isSshProject, sshConnectionIdFromUri } from './sshWorkspace'
import { isTauri, safeInvoke } from './tauri'
import { isWslProject, wslDistroNameFromPath } from './wslWorkspace'
import { isProjectTrusted, pushTrustedRootsToNative } from './workspaceTrust'
import { uploadLocalFilesForSshTerminal } from './sshTerminalPaste'
import { getTerminalProfile, loadTerminalProfileSettings } from './terminal/terminalProfiles'
import { isTerminalProfileTrusted } from './terminal/terminalProfileTrust'
import { normalizeTerminalShell } from './terminal/terminalShell'

interface Request {
  id: string
  project?: string | null
  attachment?: string | null
  /** 列出终端配置（不含命令）。 */
  profiles?: boolean
  /** 按 id 解析一个终端配置，供手机新建会话。 */
  profile?: string
}

function profileName(name: string) {
  return name.trim() || '未命名配置'
}

/** 手机端只拿到名称与信任状态；命令留在电脑端，创建时按 id 再解析。 */
export function mobileTerminalProfiles() {
  return loadTerminalProfileSettings().profiles.map(profile => ({
    id: profile.id,
    name: profileName(profile.name),
    trusted: isTerminalProfileTrusted(profile),
  }))
}

export function mobileTerminalProfile(id: string) {
  if (!loadTerminalProfileSettings().profiles.some(profile => profile.id === id)) {
    throw new Error('终端配置不存在或已删除，请刷新后重试。')
  }
  // 与电脑端新建配置终端一致：内置「普通终端」跟随全局默认 shell。
  const profile = getTerminalProfile(id)
  if (!isTerminalProfileTrusted(profile)) {
    throw new Error(`请先在电脑上新建一次「${profileName(profile.name)}」终端并选择「信任此配置」，再从手机启动。`)
  }
  return {
    id: profile.id,
    name: profileName(profile.name),
    // 与电脑端一致：多行命令以 `; ` 连接。
    command: profile.command.trim().replace(/\s*\n+\s*/g, '; '),
    shell: normalizeTerminalShell(profile.shell),
  }
}

function mobileProject(project: Project, connections: Map<string, Pick<SshConnection, 'name' | 'host'>>) {
  const kind = isSshProject(project) ? 'ssh' : isWslProject(project) ? 'wsl' : 'local'
  const connection = project.connection_id || sshConnectionIdFromUri(project.path)
  const remote = kind === 'ssh' ? connections.get(connection ?? '') : undefined
  const host = kind === 'ssh'
    ? remote?.host ?? 'SSH'
    : kind === 'wsl' ? wslDistroNameFromPath(project.path) ?? 'WSL' : 'Windows'
  return { id: project.id, name: project.name, path: project.path, kind, host, connectionName: remote?.name, lastOpenedAt: project.last_opened_at }
}

async function respond({ project: projectId = null, attachment, profiles, profile }: Request) {
  if (profiles) return mobileTerminalProfiles()
  if (profile !== undefined) return mobileTerminalProfile(profile)
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
    if (attachment) {
      if (!isSshProject(project)) throw new Error('附件上传需要远端项目。')
      return { path: await uploadLocalFilesForSshTerminal(project.path, [attachment]) }
    }
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
    const result = await respond(payload).then(
      data => ({ data }),
      error => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    await safeInvoke('回复移动端请求', 'mobile_bridge_reply', { id: payload.id, ...result })
      .catch(error => console.warn('Mobile bridge reply failed', error))
  })
}
