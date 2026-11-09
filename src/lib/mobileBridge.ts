import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useProjectStore } from '@/store/projectStore'
import type { Project, SshConnection } from '@/types'
import { listProjects, listSshConnections, withDb } from './projectRepository'
import { getSshServerEnabled } from './sshServerSettings'
import { ensureSshWorkspaceConnected, isSshProject, resolveSshConnectionMode, sshConnectionIdFromUri } from './sshWorkspace'
import { isTauri, safeInvoke } from './tauri'
import { isWslProject, wslDistroNameFromPath } from './wslWorkspace'
import { isProjectTrusted, pushTrustedRootsToNative } from './workspaceTrust'
import { uploadLocalFilesForSshTerminal } from './sshTerminalPaste'
import { getTerminalProfile, loadTerminalProfileSettings } from './terminal/terminalProfiles'
import { isTerminalProfileTrusted } from './terminal/terminalProfileTrust'
import { normalizeTerminalShell } from './terminal/terminalShell'
import { captureTerminalForMirror, useTerminalStore } from '@/store/terminalStore'
import { useTerminalControlStore } from '@/store/terminalControlStore'
import { beginTerminalMirror, stopTerminalMirror } from './terminal/terminalMirror'
import { isTerminalProgramBusy } from './terminal/terminalProgramActivity'
import { isMobileTerminalId } from './ipc/mobileSessions'
import type { TerminalTab } from '@/types'

interface Request {
  id: string
  project?: string | null
  attachment?: string | null
  /** 列出终端配置（不含命令）。 */
  profiles?: boolean
  /** 按 id 解析一个终端配置，供手机新建会话。 */
  profile?: string
  /** 列出可供手机接入的电脑终端。 */
  desktopTerminals?: boolean
  /** 手机接入电脑终端：抓取当前画面并开始转发。 */
  mirrorStart?: string
  device?: string
  /** 手机结束电脑上的终端。 */
  endTerminal?: string
  /** 电脑重启后在后台连接远端项目，以便接回仍在运行的手机终端。 */
  connectRemoteProjects?: boolean
}

/** 只开放交互式终端：运行任务的输出可能含密钥，先不让手机接入。 */
export function isDesktopTerminalShareable(tab: TerminalTab) {
  return !isMobileTerminalId(tab.id)
    && (tab.status === 'running' || tab.status === 'reconnecting')
    && !tab.runEnvironment
    && (tab.shellKind === undefined || tab.shellKind === 'interactive')
}

async function trustedProjectMap() {
  const projects = await withDb('加载移动端项目列表', listProjects)
  const connections = await listSshConnections()
  const hosts = new Map(connections.map(connection => [connection.id, connection]))
  return new Map(projects
    .filter(project => !project.ephemeral && isProjectTrusted(project))
    .map(project => [project.id, mobileProject(project, hosts)]))
}

async function listDesktopTerminals() {
  const projects = await trustedProjectMap()
  return useTerminalStore.getState().terminals.flatMap(tab => {
    const project = projects.get(tab.projectId)
    if (!project || !isDesktopTerminalShareable(tab)) return []
    return [{
      id: tab.id,
      name: tab.name,
      customName: null,
      programTitle: null,
      programBusy: isTerminalProgramBusy(tab.id),
      createdAt: tab.createdAt ?? tab.startedAt ?? null,
      lastActiveAt: 0,
      idleDeadline: null,
      project,
    }]
  })
}

async function shareableTerminal(id: string) {
  const projects = await trustedProjectMap()
  const tab = useTerminalStore.getState().terminals.find(candidate => candidate.id === id)
  const project = tab && projects.get(tab.projectId)
  if (!tab || !project || !isDesktopTerminalShareable(tab)) {
    throw new Error('该电脑终端已关闭或不可接入。')
  }
  return { tab, project }
}

async function startDesktopTerminalMirror(id: string, device: string) {
  const { tab, project } = await shareableTerminal(id)
  const open = beginTerminalMirror(id)
  try {
    const capture = await captureTerminalForMirror(id)
    await safeInvoke('建立终端转发', 'mobile_mirror_seed', {
      id, device, project, name: tab.name, cols: capture.cols, rows: capture.rows, data: capture.data,
    })
    open()
  } catch (error) {
    stopTerminalMirror(id)
    throw error
  }
  return null
}

/** 使用权变化：有设备在用时电脑只读并跟随对方行列，否则恢复并停止转发。 */
export function applyTerminalControl(payload: { id: string; controller: string | null; cols: number; rows: number }) {
  const controls = useTerminalControlStore.getState()
  if (payload.controller) {
    controls.setControl(payload.id, { name: payload.controller, cols: payload.cols, rows: payload.rows })
    return
  }
  controls.clearControl(payload.id)
  stopTerminalMirror(payload.id)
}

/** 只有 Server 模式的连接有持久终端；指纹未确认的主机要用户在电脑上确认，后台不碰。 */
export function mobileRestoreTargets(
  projects: readonly Project[],
  connections: readonly SshConnection[],
  serverEnabled: boolean,
) {
  const hosts = new Map(connections.map(connection => [connection.id, connection]))
  return projects.filter(project => {
    if (project.ephemeral || !isSshProject(project) || !isProjectTrusted(project)) return false
    const connection = hosts.get(project.connection_id || sshConnectionIdFromUri(project.path) || '')
    return !!connection?.host_key_fingerprint
      && resolveSshConnectionMode(connection, serverEnabled) === 'server'
  })
}

async function connectRemoteProjects() {
  const projects = await withDb('加载移动端项目列表', listProjects)
  const ephemeral = useProjectStore.getState().projects.filter(project => project.ephemeral)
  await pushTrustedRootsToNative([...projects, ...ephemeral])
  const targets = mobileRestoreTargets(projects, await listSshConnections(), getSshServerEnabled())
  const { signal } = new AbortController()
  for (const project of targets) {
    // 连不上就跳过：主机离线、未保存密码都不打扰电脑前的用户。
    await ensureSshWorkspaceConnected(project, { background: true, signal }).catch(() => undefined)
  }
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

async function respond({
  project: projectId = null, attachment, profiles, profile, desktopTerminals, mirrorStart, device, endTerminal,
  connectRemoteProjects: connectRemote,
}: Request) {
  if (connectRemote) {
    // 主机可能很慢，不占用桥接请求的超时；连上后由电脑端的扫描接回。
    void connectRemoteProjects().catch(error => console.warn('Mobile restore connect failed', error))
    return null
  }
  if (desktopTerminals) return listDesktopTerminals()
  if (mirrorStart !== undefined) return startDesktopTerminalMirror(mirrorStart, device ?? '')
  if (endTerminal !== undefined) {
    await shareableTerminal(endTerminal)
    await useTerminalStore.getState().closeTerminal(endTerminal)
    return null
  }
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
  // 窗口重载后转发已丢失，把残留的使用权还给电脑。
  void safeInvoke('释放手机接入', 'mobile_release_mirrors').catch(() => undefined)
  const unlistenControl = await listen<Parameters<typeof applyTerminalControl>[0]>(
    'terminal-control',
    ({ payload }) => applyTerminalControl(payload),
  )
  const unlistenRequests = await listen<Request>('mobile-request', async ({ payload }) => {
    const result = await respond(payload).then(
      data => ({ data }),
      error => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    await safeInvoke('回复移动端请求', 'mobile_bridge_reply', { id: payload.id, ...result })
      .catch(error => console.warn('Mobile bridge reply failed', error))
  })
  return () => {
    unlistenControl()
    unlistenRequests()
  }
}
