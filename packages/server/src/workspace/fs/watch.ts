import { watch, type FSWatcher } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { FsChangedEvt } from '@qn/protocol'
import type { WorkspaceContext } from '../registry'
import { MAX_WATCH_PATHS, parseWatchPaths } from './logic'

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
  for (const target of unique.slice(0, MAX_WATCH_PATHS)) {
    let isDir = false
    try {
      isDir = (await fsp.stat(target)).isDirectory()
    } catch {
      // 不存在的路径不监听：fs.watch 只会报错并占用一个 watcher。
      ctx.log('fs.watch 跳过不存在的路径')
      continue
    }
    try {
      // 不启用 recursive：Linux 不支持，且目录非递归已满足刷新需求。
      const watcher = watch(target, { persistent: false }, (_event, filename) => {
        const name = filename === null || filename === undefined ? null : String(filename)
        const changed = isDir && name !== null && name.length > 0 ? path.join(target, name) : target
        state.pending.add(changed)
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
