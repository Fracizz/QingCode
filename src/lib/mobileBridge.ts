import { loadExcludeSettingsForProject } from './excludeSettings'
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
import { currentShortcutBarState } from '@/store/terminalShortcutBarStore'
import { normalizeTerminalShell } from './terminal/terminalShell'
import { captureTerminalForMirror, useTerminalStore } from '@/store/terminalStore'
import { applyTerminalControlPayload, type TerminalControlPayload } from '@/store/terminalControlStore'
import { terminalViewGrids } from '@/store/terminal/ptySizing'
import { isTerminalProgramBusy } from './terminal/terminalProgramActivity'
import { terminalLastActiveAt } from './terminal/terminalLastActive'
import { isMobileTerminalId } from './ipc/mobileSessions'
import type { TerminalTab } from '@/types'

interface Request {
  id: string
  fileAccess?: boolean
  fileRules?: boolean
  project?: string | null
  attachment?: string | null
  /** 列出终端配置（不含命令）。 */
  profiles?: boolean
  /** 列出快捷键栏的自定义键，供手机导入。 */
  shortcutKeys?: boolean
  /** 按 id 解析一个终端配置，供手机新建会话。 */
  profile?: string
  /** 列出可供手机接入的电脑终端。 */
  desktopTerminals?: boolean
  /** 手机接入电脑终端：检查能否共享，`seed` 为 true 时附上电脑当前画面。 */
  mirrorStart?: string
  device?: string
  seed?: boolean
  /** 手机结束电脑上的终端。 */
  endTerminal?: string
  /** 电脑重启后在后台连接远端项目，以便接回仍在运行的手机终端。 */
  connectRemoteProjects?: boolean
  /** 列表里同时给出未信任项目（`trusted: false`），供手机置灰显示，与电脑端项目数一致。 */
  allProjects?: boolean
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
      // 手机首页「待处理」据此显示「N 分钟前」；没有记录时给 null，不能给 0（会被算成 1970 年）
      lastActiveAt: terminalLastActiveAt(tab),
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

/**
 * 手机首次接入电脑终端：检查是已信任项目里的交互式终端后登记给 Rust。输出由 Rust 直接分发，
 * 只有 Rust 侧镜像不完整时才附上电脑当前画面；行列是电脑窗口自己的网格，供尺寸交还时使用。
 */
async function startDesktopTerminalMirror(id: string, seed: boolean) {
  const { tab, project } = await shareableTerminal(id)
  const capture = seed ? await captureTerminalForMirror(id) : undefined
  const grid = terminalViewGrids.get(id) ?? capture
  await safeInvoke('登记终端共享', 'mobile_mirror_seed', {
    id,
    project,
    name: tab.name,
    cols: grid?.cols ?? 80,
    rows: grid?.rows ?? 24,
    data: capture?.data ?? null,
  })
  return null
}

/** 共享状态变化：设备在线、独占、尺寸方。电脑只在被设备独占时只读。 */
export function applyTerminalControl(payload: TerminalControlPayload) {
  applyTerminalControlPayload(payload)
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

/** 手机导入用：只给名称、文本与回车设置；终端内快捷键是电脑键盘专用，不下发。 */
export function mobileShortcutKeys() {
  return currentShortcutBarState().custom.map(({ name, text, enter }) => ({ name, text, enter }))
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
  project: projectId = null, attachment, profiles, shortcutKeys, profile, desktopTerminals, mirrorStart, seed, endTerminal,
  connectRemoteProjects: connectRemote, fileAccess, fileRules, allProjects,
}: Request) {
  if (connectRemote) {
    // 主机可能很慢，不占用桥接请求的超时；连上后由电脑端的扫描接回。
    void connectRemoteProjects().catch(error => console.warn('Mobile restore connect failed', error))
    return null
  }
  if (desktopTerminals) return listDesktopTerminals()
  if (mirrorStart !== undefined) return startDesktopTerminalMirror(mirrorStart, seed !== false)
  if (endTerminal !== undefined) {
    await shareableTerminal(endTerminal)
    await useTerminalStore.getState().closeTerminal(endTerminal)
    return null
  }
  if (profiles) return mobileTerminalProfiles()
  if (shortcutKeys) return mobileShortcutKeys()
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
    if (fileAccess) {
      const rules = fileRules ? await loadExcludeSettingsForProject(project) : null
      return { path: project.path, excludes: rules?.filesExclude ?? [], excludeGitIgnore: rules?.excludeGitIgnore ?? false }
    }
    if (attachment) {
      if (!isSshProject(project)) throw new Error('附件上传需要远端项目。')
      return { path: await uploadLocalFilesForSshTerminal(project.path, [attachment]) }
    }
    const connections = await listSshConnections()
    return mobileProject(project, new Map(connections.map(connection => [connection.id, connection])))
  }
  const connections = await listSshConnections()
  const hosts = new Map(connections.map(connection => [connection.id, connection]))
  if (!allProjects) return trusted.map(project => mobileProject(project, hosts))
  // 未信任项目只给名称与位置：打开、新建终端、浏览文件仍走上面按 id 的信任校验。
  return projects
    .filter(project => !project.ephemeral)
    .map(project => ({ ...mobileProject(project, hosts), trusted: isProjectTrusted(project) }))
}

export async function listenForMobileRequests(): Promise<() => void> {
  if (!isTauri() || getCurrentWebviewWindow().label !== 'main') return () => {}
  const unlistenControl = await listen<TerminalControlPayload>(
    'terminal-control',
    ({ payload }) => applyTerminalControl(payload),
  )
  // 窗口重载后恢复共享提示；手机的接入与输出在 Rust 侧，重载不受影响。
  void safeInvoke<TerminalControlPayload[]>('读取终端共享状态', 'mobile_terminal_controls')
    .then(controls => controls.forEach(applyTerminalControl))
    .catch(() => undefined)
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
