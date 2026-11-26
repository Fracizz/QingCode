import { watch, type FSWatcher } from 'node:fs'
import { promises as fsp } from 'node:fs'
import type { FsChangedEvt } from '@qn/protocol'
import type { WorkspaceContext } from '../registry'
import { MAX_WATCH_PATHS, parseWatchPaths, watchChangedPath } from './logic'

const DEBOUNCE_MS = 200

interface WatchState {
  watchers: FSWatcher[]
  pending: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

const states = new WeakMap<WorkspaceContext, WatchState>()

function closeAll(state: WatchState): void {
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
  state.pending.clear()
  for (const watcher of state.watchers.splice(0)) {
    try {
      watcher.close()
    } catch {
      // 已关闭的 watcher 再次 close 无需处理。
    }
  }
}

function stateFor(ctx: WorkspaceContext): WatchState {
  const existing = states.get(ctx)
  if (existing) return existing
  const state: WatchState = { watchers: [], pending: new Set() }
  states.set(ctx, state)
  ctx.onClose(() => closeAll(state))
  return state
}

/** 每次调用全量替换本连接的监听集合；变化 200ms 去抖后合并推送。 */
export async function fsWatch(
  p: Record<string, unknown>,
  ctx: WorkspaceContext,
): Promise<Record<string, never>> {
  const paths = parseWatchPaths(p)
  const state = stateFor(ctx)
  closeAll(state)

  const unique = [...new Set(paths)]
  if (unique.length > MAX_WATCH_PATHS) {
    ctx.log(`fs.watch 路径数 ${unique.length} 超过上限 ${MAX_WATCH_PATHS}，已截断`)
  }
  const targets = unique.slice(0, MAX_WATCH_PATHS)
  // 并发判类型：500 个路径逐个 await stat 会让 fs.watch 迟迟不返回。
  const dirFlags = await Promise.all(
    targets.map(async (target) => {
      try {
        return (await fsp.stat(target)).isDirectory()
      } catch {
        return null
      }
    }),
  )
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!
    const isDir = dirFlags[index]
    if (isDir === null || isDir === undefined) {
      // 不存在的路径不监听：fs.watch 只会报错并占用一个 watcher。
      ctx.log('fs.watch 跳过不存在的路径')
      continue
    }
    try {
      // 不启用 recursive：Linux 不支持，且目录非递归已满足刷新需求。
      const watcher = watch(target, { persistent: false }, (_event, filename) => {
        state.pending.add(watchChangedPath(target, filename, isDir))
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = setTimeout(() => {
          state.timer = undefined
          if (state.pending.size === 0) return
          const changedPaths = [...state.pending]
          state.pending.clear()
          const payload: FsChangedEvt = { paths: changedPaths }
          ctx.emit('fs.changed', payload)
        }, DEBOUNCE_MS)
      })
      watcher.on('error', () => {
        ctx.log('fs.watch 监听出错，已关闭该监听')
        watcher.close()
      })
      state.watchers.push(watcher)
    } catch (err) {
      ctx.log(`fs.watch 无法监听: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {}
}
