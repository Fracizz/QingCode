import { useEffect } from 'react'
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
 * 当前聚焦窗口协调全应用预算；配置串行，切换/撤销信任立即使旧项失效。
 * 本机项目只在 Windows 客户端预热；SSH 项目交给后端判断远端是否为 Windows 且走 Server 模式。
 */
export function useShellPrewarm(project: Project | null) {
  useEffect(() => {
    if (!isTauri()) return
    const localHostWindows = detectTerminalHostPlatform() === 'win'
    let disposed = false
    let revision = 0
    let sequence = Promise.resolve()
    // invalidate=true：先失效，再异步读设置，避免慢读取期间领取过期项。
    // 仅窗口获得焦点时条件未变，直接重发同一配置，后端会保留已就绪的 Shell。
    const refresh = (invalidate = true) => {
      const current = ++revision
      const cleared = invalidate ? configure(null, null, 0) : Promise.resolve()
      const stale = () => disposed || current !== revision || !document.hasFocus()
      sequence = sequence.then(async () => {
        await cleared
        if (stale()) return
        const remote = project?.path.startsWith('ssh://') ?? false
        if (!project || project.ephemeral || (!remote && !localHostWindows) || !isProjectTrusted(project)) {
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
      }).catch(() => {})
    }
    const invalidate = () => refresh(true)
    const focus = () => refresh(false)
    const storage = (event: StorageEvent) => {
      if (!event.key || event.key === TERMINAL_PROFILES_KEY || event.key === 'qingcode:workspace-trust') invalidate()
    }
    invalidate()
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, invalidate)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, invalidate)
    window.addEventListener(WORKSPACE_TRUST_SYNCED_EVENT, invalidate)
    window.addEventListener('focus', focus)
    window.addEventListener('storage', storage)
    return () => {
      disposed = true
      revision++
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, invalidate)
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, invalidate)
      window.removeEventListener(WORKSPACE_TRUST_SYNCED_EVENT, invalidate)
      window.removeEventListener('focus', focus)
      window.removeEventListener('storage', storage)
      void configure(null, null, 0)
    }
  }, [project])
}
