import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { GIT_PUSHED_EVENT } from '@/lib/ipc/git'
import { hasBackend } from '@/lib/runtimeCapabilities'
import { useProjectStore } from '@/store/projectStore'
import type { PushNotice } from './engine'
import { gitPushSyncEngine as engine, loadConfig } from './runtime'
import { useGitPushSyncStore, type DetectionState } from './store'

type StatePayload = { projectPath: string; state: DetectionState; detail: string | null }

const WATCH_REFRESH_COOLDOWN_MS = 2 * 60 * 1000

function warn(action: string) {
  return (error: unknown) => console.warn(`git push sync: ${action} failed:`, error)
}

/** 应用级生命周期：只订阅事件，不设定时器；功能关闭时不产生 Git 命令。 */
export function useGitPushSync(projectsReady: boolean) {
  useEffect(() => {
    if (!hasBackend() || !projectsReady) return
    let disposed = false
    let lastWatchRefresh = 0

    const refreshWatches = () => {
      lastWatchRefresh = Date.now()
      void engine.refreshWatches().catch(warn('refresh watches'))
    }
    const unlisteners = [
      listen<PushNotice>('git-push-sync:pushed', event => {
        void engine.handlePush(event.payload).catch(warn('handle push'))
      }),
      listen<StatePayload>('git-push-sync:state', event => {
        const { projectPath, state, detail } = event.payload
        useGitPushSyncStore.getState().setDetection(projectPath, { state, detail })
      }),
    ]
    const onPanelPush = (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail.path
      void engine.handlePanelPush(path).catch(warn('handle panel push'))
    }
    // 窗口聚焦代表用户回来了：补查离线期间错过的推送，并接上新连接的项目。
    const onFocus = () => {
      void engine.catchUpAll().catch(warn('catch up'))
      if (Date.now() - lastWatchRefresh >= WATCH_REFRESH_COOLDOWN_MS) refreshWatches()
    }
    window.addEventListener(GIT_PUSHED_EVENT, onPanelPush)
    window.addEventListener('focus', onFocus)

    const unsubscribeConfig = useGitPushSyncStore.subscribe((state, previous) => {
      const { config } = state
      const changed =
        config.enabled !== previous.config.enabled ||
        config.receivers.join() !== previous.config.receivers.join()
      if (!changed) return
      refreshWatches()
      void engine.catchUpAll({ force: true }).catch(warn('catch up'))
    })
    const unsubscribeProject = useProjectStore.subscribe((state, previous) => {
      const project = state.currentProject
      if (project && project.id !== previous.currentProject?.id) {
        void engine.catchUp(project).catch(warn('catch up'))
      }
    })

    void loadConfig()
      .then(() => {
        if (disposed) return
        refreshWatches()
        void engine.catchUpAll().catch(warn('catch up'))
      })
      .catch(warn('load config'))

    return () => {
      disposed = true
      window.removeEventListener(GIT_PUSHED_EVENT, onPanelPush)
      window.removeEventListener('focus', onFocus)
      unsubscribeConfig()
      unsubscribeProject()
      for (const unlisten of unlisteners) void unlisten.then(stop => stop())
    }
  }, [projectsReady])
}
