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

/** 当前聚焦窗口协调全应用预算；配置串行，切换/撤销信任立即使旧项失效。 */
export function useShellPrewarm(project: Project | null) {
  useEffect(() => {
    if (!isTauri() || detectTerminalHostPlatform() !== 'win') return
    let disposed = false
    let revision = 0
    let sequence = Promise.resolve()
    const refresh = () => {
      const current = ++revision
      // 先失效，再异步读设置；避免慢读取期间领取上一个项目的预热项。
      const cleared = configure(null, null, 0)
      sequence = sequence.then(async () => {
        await cleared
        if (disposed || current !== revision || !document.hasFocus() || !project || project.ephemeral ||
          project.path.startsWith('ssh://') || !isProjectTrusted(project)) return
        const [count, persist] = await Promise.all([
          loadShellPrewarmCount(), loadEffectiveTerminalPersistLocalSessions(project),
        ])
        const shell = loadTerminalProfileSettings().defaultShell
        if (disposed || current !== revision || !document.hasFocus() || !persist || shell === 'wsl') return
        await configure(project.path, shell, count)
      }).catch(() => {})
    }
    const storage = (event: StorageEvent) => {
      if (!event.key || event.key === TERMINAL_PROFILES_KEY || event.key === 'qingcode:workspace-trust') refresh()
    }
    refresh()
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, refresh)
    window.addEventListener(WORKSPACE_TRUST_SYNCED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('storage', storage)
    return () => {
      disposed = true
      revision++
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, refresh)
      window.removeEventListener(WORKSPACE_TRUST_SYNCED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('storage', storage)
      void configure(null, null, 0)
    }
  }, [project])
}
