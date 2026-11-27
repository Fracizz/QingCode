import { useEffect } from 'react'
import { getExplorerWatchPaths, subscribeExplorerWatch } from '../features/explorer'
import { getFileWatchPaths, subscribeFileWatch } from '../features/files'
import { getRunWatchPaths, subscribeRunWatch } from '../features/run'
import { serverCall } from '../features/workspace/serverCall'
import { useTargets } from '../store/targets'

// fs.watch 每连接一个集合、全量替换：文件面板与文件树各自给出路径，这里合并去重后统一登记。

export function mergeWatchPaths(...lists: string[][]): string[] {
  return [...new Set(lists.flat().filter((path) => path !== ''))].sort()
}

export function useWorkspaceWatch(): void {
  useEffect(() => {
    // 上次登记的内容，避免重复发送；连接重建（重新 ready）后清空以强制重发。
    const sent = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const sync = (): void => {
      const { states } = useTargets.getState()
      for (const [targetId, info] of Object.entries(states)) {
        if (info?.state !== 'ready') {
          sent.delete(targetId)
          continue
        }
        const paths = mergeWatchPaths(getFileWatchPaths(targetId), getExplorerWatchPaths(targetId), getRunWatchPaths(targetId))
        const key = paths.join('\n')
        if (sent.get(targetId) === key) continue
        sent.set(targetId, key)
        void serverCall(targetId, 'fs.watch', { paths }).catch(() => {
          // 旧 server 不支持或连接中断：下次变化或重连时再试。
          sent.delete(targetId)
        })
      }
    }
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, 150)
    }

    const offFiles = subscribeFileWatch(schedule)
    const offExplorer = subscribeExplorerWatch(schedule)
    const offRun = subscribeRunWatch(schedule)
    const offTargets = useTargets.subscribe((state, previous) => {
      if (state.states !== previous.states) {
        for (const [id, info] of Object.entries(state.states)) {
          if (info?.state === 'ready' && previous.states[id]?.state !== 'ready') sent.delete(id)
        }
        schedule()
      }
    })
    schedule()
    return () => {
      if (timer) clearTimeout(timer)
      offFiles()
      offExplorer()
      offRun()
      offTargets()
    }
  }, [])
}
