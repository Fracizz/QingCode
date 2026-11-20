import { localCodexPrewarm, LOCAL_CODEX_PREWARM_KEY } from '../lib/terminal/localCodexPrewarm'
import { CONNECTION_PREWARM_PREFIX, connectionPrewarmAnchors, connectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { TERMINAL_PROFILE_TRUST_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_KEY } from '../lib/terminal/terminalProfileTrust'
import { sshConnectionIdFromUri } from '../lib/sshWorkspace'
import { useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Project } from '../types'
import { isTauri, safeInvoke } from '../lib/tauri'
import { isProjectTrusted, WORKSPACE_TRUST_CHANGED_EVENT, WORKSPACE_TRUST_SYNCED_EVENT } from '../lib/workspaceTrust'
import { loadShellPrewarmCount, SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import { loadEffectiveTerminalPersistLocalSessions } from '../lib/terminal/terminalPersistLocalSettings'
import { getPrewarmShell, TERMINAL_PROFILES_KEY } from '../lib/terminal/terminalProfiles'
import { detectTerminalHostPlatform } from '../lib/terminal/terminalShell'

let backendSequence = Promise.resolve()
type PrewarmProfile = { cwd: string; profileId: string; command: string; shell: string }
function configure(cwd: string | null, shell: string | null, count: 'auto' | number, profile?: PrewarmProfile, localProfile?: Omit<PrewarmProfile, 'cwd'>, anchoredProfiles?: PrewarmProfile[]) {
  backendSequence = backendSequence.then(() =>
    safeInvoke('配置 Shell 预热', 'configure_shell_prewarm', { cwd, shell, count, ...(profile && { profile }), ...(localProfile && { localProfile }), ...(anchoredProfiles?.length && { anchoredProfiles }) }),
  ).then(() => {}, () => {})
  return backendSequence
}

/**
 * 最近聚焦的原生窗口同步每条连接及本机的预热数量；配置串行，撤销信任、改设置立即使旧项失效。
 * 本机项目只在 Windows 客户端预热；SSH 项目交给后端判断远端是否为 Windows 且走 Server 模式。
 * 预热项按主机复用：切换项目只复查条件，同一主机上已就绪的 Shell 保留，领取时再切到目标目录。
 */
export function useShellPrewarm(project: Project | null) {
  const projectRef = useRef(project)
  const recheckRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    const localHostWindows = detectTerminalHostPlatform() === 'win'
    let disposed = false
    let revision = 0
    let localProject: Project | null = null
    // invalidate=true：先失效，再异步读设置，避免慢读取期间领取过期项。
    // 获得焦点、切换项目等条件未变（或只换了同主机目录）时直接重发配置，后端会保留已就绪的 Shell。
    // 后端调用已串行；较早的刷新在每次等待后检查 revision，过期即放弃，慢读取也不会挡住新项目。
    const refresh = (invalidate = true) => {
      const current = ++revision
      const cleared = invalidate ? configure(null, null, 0) : Promise.resolve()
      const stale = () => disposed || current !== revision
      void (async () => {
        await cleared
        if (stale()) return
        const active = projectRef.current
        if (!active?.path.startsWith('ssh://')) localProject = active
        const local = localHostWindows && localProject && (localProject.ephemeral || isProjectTrusted(localProject)) ? localProject : null
        const codex = localHostWindows ? localCodexPrewarm() : undefined
        const [count, persist] = await Promise.all([
          loadShellPrewarmCount(), local || codex ? loadEffectiveTerminalPersistLocalSessions(local) : false,
        ])
        const shell = getPrewarmShell()
        if (stale()) return
        const connectionId = active && sshConnectionIdFromUri(active.path)
        const preset = active && connectionId && isProjectTrusted(active) && connectionPrewarmProfile(connectionId)
        const profile = active && preset ? { cwd: active.path, profileId: preset.id, shell: preset.shell,
          command: preset.command.trim().replace(/\s*\n+\s*/g, '; ') } : undefined
        const localProfile = persist && codex ? { profileId: codex.id,
          shell: codex.shell, command: codex.command.trim() } : undefined
        await configure(persist && shell !== 'wsl' ? local?.path ?? null : null, shell, count, profile, localProfile, connectionPrewarmAnchors())
      })().catch(() => {})
    }
    const invalidate = () => refresh(true)
    // 获得焦点、信任列表同步到原生（手机请求、项目列表刷新都会触发）、切换项目只复查条件：
    // 仍受信任且主机与配置不变时保留已就绪项，不能把刚被领取预留的 Shell 一起清掉。
    const recheck = () => refresh(false)
    // 手机请求也会同步信任列表；空闲时由原生池定期复查，避免每次同步都发起 SFTP 请求。
    const onTrustSynced = () => { if (document.hasFocus()) recheck() }
    recheckRef.current = recheck
    const storage = (event: StorageEvent) => {
      if (!event.key || event.key === LOCAL_CODEX_PREWARM_KEY || event.key.startsWith(CONNECTION_PREWARM_PREFIX) || event.key === TERMINAL_PROFILE_TRUST_KEY || event.key === TERMINAL_PROFILES_KEY || event.key === 'qingcode:workspace-trust') invalidate()
    }
    // WebView 失焦时，CLI 仍能导入设置；窗口归属由所有 WebView 共用的原生池判断。
    let unlisten: (() => void) | undefined
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused && !disposed) recheck()
    }).then(stop => {
      if (disposed) stop()
      else unlisten = stop
    }).finally(() => {
      if (!disposed) recheck()
    }).catch(() => {})
    // CLI 设置导入可由主窗口处理，预算却在另一个窗口。接收方只重读，不再次广播。
    const settingsChannel = new BroadcastChannel(SHELL_PREWARM_CHANGED_EVENT)
    settingsChannel.onmessage = recheck
    const onSettingsChanged = (event: Event) => {
      // 切项目会重读设置；相同的配置应保留已经就绪的 Shell。
      if (event instanceof CustomEvent && event.detail === 'project-switch') {
        recheck()
        return
      }
      invalidate()
      settingsChannel.postMessage(null)
    }
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, onSettingsChanged)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, invalidate)
    window.addEventListener(WORKSPACE_TRUST_SYNCED_EVENT, onTrustSynced)
    window.addEventListener(TERMINAL_PROFILE_TRUST_CHANGED_EVENT, invalidate)
    window.addEventListener('storage', storage)
    return () => {
      disposed = true
      revision++
      recheckRef.current = null
      settingsChannel.close()
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, onSettingsChanged)
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, invalidate)
      window.removeEventListener(WORKSPACE_TRUST_SYNCED_EVENT, onTrustSynced)
      unlisten?.()
      window.removeEventListener(TERMINAL_PROFILE_TRUST_CHANGED_EVENT, invalidate)
      window.removeEventListener('storage', storage)
      void configure(null, null, 0)
    }
  }, [])

  // 首次挂载已在焦点监听建立后复查；之后换项目只复查，不先清空。
  useEffect(() => {
    if (projectRef.current === project) return
    projectRef.current = project
    recheckRef.current?.()
  }, [project])
}
