import { useEffect, useRef } from 'react'
import type { Project } from '../types'
import { isTauri, safeInvoke } from '../lib/tauri'
import { isProjectTrusted, WORKSPACE_TRUST_CHANGED_EVENT, WORKSPACE_TRUST_SYNCED_EVENT } from '../lib/workspaceTrust'
import { loadShellPrewarmCount, SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import { loadEffectiveTerminalPersistLocalSessions } from '../lib/terminal/terminalPersistLocalSettings'
import { loadTerminalProfileSettings, TERMINAL_PROFILES_KEY } from '../lib/terminal/terminalProfiles'
import { detectTerminalHostPlatform } from '../lib/terminal/terminalShell'

let backendSequence = Promise.resolve()
function configure(cwd: string | null, shell: string | null, count: 'auto' | number) {
  backendSequence = backendSequence.then(() =>
    safeInvoke('配置 Shell 预热', 'configure_shell_prewarm', { cwd, shell, count }),
  ).then(() => {}, () => {})
  return backendSequence
}

/**
 * 当前聚焦窗口协调全应用预算；配置串行，撤销信任、改设置立即使旧项失效。
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
    // invalidate=true：先失效，再异步读设置，避免慢读取期间领取过期项。
    // 获得焦点、切换项目等条件未变（或只换了同主机目录）时直接重发配置，后端会保留已就绪的 Shell。
    // 后端调用已串行；较早的刷新在每次等待后检查 revision，过期即放弃，慢读取也不会挡住新项目。
    const refresh = (invalidate = true) => {
      const current = ++revision
      const cleared = invalidate ? configure(null, null, 0) : Promise.resolve()
      const stale = () => disposed || current !== revision || !document.hasFocus()
      void (async () => {
        await cleared
        if (stale()) return
        const project = projectRef.current
        const remote = project?.path.startsWith('ssh://') ?? false
        // 临时项目（草稿目录）打开即自动信任，与终端新建的判断一致，同样预热。
        if (!project || (!remote && !localHostWindows) || !(project.ephemeral || isProjectTrusted(project))) {
          if (!invalidate) await configure(null, null, 0)
          return
        }
        // 「本地终端可接回」只约束本机项目；SSH Server 模式终端本身就由远端 daemon 托管。
        const [count, persist] = await Promise.all([
          loadShellPrewarmCount(), remote ? true : loadEffectiveTerminalPersistLocalSessions(project),
        ])
        const shell = loadTerminalProfileSettings().defaultShell
        if (stale()) return
        await configure(persist && (remote || shell !== 'wsl') ? project.path : null, shell, count)
      })().catch(() => {})
    }
    const invalidate = () => refresh(true)
    // 获得焦点、信任列表同步到原生（手机请求、项目列表刷新都会触发）、切换项目只复查条件：
    // 仍受信任且主机与配置不变时保留已就绪项，不能把刚被领取预留的 Shell 一起清掉。
    const recheck = () => refresh(false)
    recheckRef.current = recheck
    const storage = (event: StorageEvent) => {
      if (!event.key || event.key === TERMINAL_PROFILES_KEY || event.key === 'qingcode:workspace-trust') invalidate()
    }
    invalidate()
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, invalidate)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, invalidate)
    window.addEventListener(WORKSPACE_TRUST_SYNCED_EVENT, recheck)
    window.addEventListener('focus', recheck)
    window.addEventListener('storage', storage)
    return () => {
      disposed = true
      revision++
      recheckRef.current = null
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, invalidate)
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, invalidate)
      window.removeEventListener(WORKSPACE_TRUST_SYNCED_EVENT, recheck)
      window.removeEventListener('focus', recheck)
      window.removeEventListener('storage', storage)
      void configure(null, null, 0)
    }
  }, [])

  // 首次挂载已由上面的 invalidate 配置；之后换项目只复查，不先清空。
  useEffect(() => {
    if (projectRef.current === project) return
    projectRef.current = project
    recheckRef.current?.()
  }, [project])
}
