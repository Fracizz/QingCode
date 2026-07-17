import { useEffect, useState } from 'react'
import { isTauri, safeInvoke } from '../lib/tauri'
import { GIT_STATUS_UPDATED_EVENT, type GitStatus } from '../lib/git'
import { useProjectStore } from '../store/projectStore'

/** Shared git status for the current project, refreshed on GIT_STATUS_UPDATED_EVENT. */
export function useGitStatus(): GitStatus | null {
  const projectPath = useProjectStore(s => s.currentProject?.path ?? null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadGitStatus = async () => {
      if (!projectPath || !isTauri()) {
        if (!cancelled) setGitStatus(null)
        return
      }
      try {
        const next = await safeInvoke<GitStatus>('读取 Git 状态', 'git_status', {
          path: projectPath,
        })
        if (!cancelled) setGitStatus(next)
      } catch {
        if (!cancelled) setGitStatus(null)
      }
    }
    void loadGitStatus()
    const onGitStatusUpdated = () => void loadGitStatus()
    window.addEventListener(GIT_STATUS_UPDATED_EVENT, onGitStatusUpdated)
    return () => {
      cancelled = true
      window.removeEventListener(GIT_STATUS_UPDATED_EVENT, onGitStatusUpdated)
    }
  }, [projectPath])

  return gitStatus
}
