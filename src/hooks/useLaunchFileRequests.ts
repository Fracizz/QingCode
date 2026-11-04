import { useEffect } from 'react'
import { listenForCliRequests } from '../lib/cliBridge'
import { listenForOpenFileRequests, openLaunchFiles } from '../lib/launchFiles'
import { isTauri, safeInvoke } from '../lib/tauri'
import { isExternalFileWindow } from '../lib/windowSession'

/**
 * Subscribe immediately for forwarded requests, but consume process argv only after
 * the initial project/editor session is restored so that activation cannot hide the file.
 */
export function useLaunchFileRequests(
  projectsReady: boolean,
  hasProject: boolean,
  openPathsKey: string,
): void {
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlistenOpen: (() => void) | undefined
    let unlistenCli: (() => void) | undefined

    void listenForOpenFileRequests().then(fn => {
      if (cancelled) fn()
      else unlistenOpen = fn
    })
    void listenForCliRequests().then(fn => {
      if (cancelled) fn()
      else unlistenCli = fn
    })

    return () => {
      cancelled = true
      unlistenOpen?.()
      unlistenCli?.()
    }
  }, [])

  useEffect(() => {
    if (!isTauri() || !projectsReady) return
    void openLaunchFiles()
  }, [projectsReady])

  useEffect(() => {
    if (!isTauri() || !isExternalFileWindow() || !hasProject) return
    void safeInvoke('切换独立文件窗口角色', 'release_external_file_window')
  }, [hasProject])

  useEffect(() => {
    if (!isTauri()) return
    const paths = openPathsKey ? openPathsKey.split('\0') : []
    void safeInvoke('同步窗口打开文件', 'sync_open_file_paths', { paths }).catch(error => {
      console.warn('sync open file paths failed:', error)
    })
  }, [openPathsKey])
}
