import { useEffect, useState } from 'react'
import { isTauri, safeInvoke } from '../lib/tauri'
import { hasPrewarmTarget, type PrewarmRecent, type PrewarmStatus } from '../lib/terminal/prewarmBadge'
import { recentShellOpenCounts } from '../lib/terminal/shellOpenDiagnostics'

/** 一个主机分组要查询的项目，当前项目排在最前。 */
export interface PrewarmStatusScope {
  key: string
  projects: ReadonlyArray<{ id: string; path: string }>
}

export interface ScopedPrewarmStatus {
  status: PrewarmStatus
  recent: PrewarmRecent
}

/** 终端列表可见期间刷新预热状态的间隔；状态读取只查进程内的池，不访问远端。 */
const POLL_MS = 3000
const EMPTY: ReadonlyMap<string, ScopedPrewarmStatus> = new Map()

/**
 * 依次查询分组内的项目，取第一个有预热目标的状态：普通 Shell 池只跟随当前项目，
 * 远端 CLI 池按连接共用，本机 CLI 池对所有本机项目都有效。
 */
export async function readScopePrewarmStatus(scope: PrewarmStatusScope): Promise<ScopedPrewarmStatus | null> {
  for (const project of scope.projects) {
    const status = await safeInvoke<PrewarmStatus>('读取 Shell 预热状态', 'shell_prewarm_status', { cwd: project.path })
      .catch(() => undefined)
    // 命令不可用（浏览器预览、旧版本）时不显示徽标。
    if (status === undefined) return null
    if (hasPrewarmTarget(status)) {
      return { status, recent: recentShellOpenCounts(new Set(scope.projects.map(p => p.id))) }
    }
  }
  return null
}

/** 轮询各主机分组的预热状态；窗口隐藏时暂停，重新可见时立即刷新。 */
export function usePrewarmStatuses(scopes: readonly PrewarmStatusScope[]): ReadonlyMap<string, ScopedPrewarmStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ScopedPrewarmStatus>>(new Map())
  // 用内容做依赖：分组对象每次渲染都会重建。
  const signature = JSON.stringify(scopes.map(s => [s.key, s.projects.map(p => [p.id, p.path])]))
  useEffect(() => {
    const list = JSON.parse(signature) as [string, [string, string][]][]
    if (!isTauri() || list.length === 0) return
    let cancelled = false
    const poll = async () => {
      if (document.visibilityState === 'hidden') return
      const next = new Map<string, ScopedPrewarmStatus>()
      for (const [key, projects] of list) {
        const found = await readScopePrewarmStatus({ key, projects: projects.map(([id, path]) => ({ id, path })) })
        if (found) next.set(key, found)
      }
      if (!cancelled) setStatuses(next)
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    const onVisible = () => void poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [signature])
  return scopes.length === 0 ? EMPTY : statuses
}
