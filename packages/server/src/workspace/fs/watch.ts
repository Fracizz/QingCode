import { watch, type FSWatcher } from 'node:fs'
import { promises as fsp } from 'node:fs'
import type { FsChangedEvt } from '@qn/protocol'
import type { WorkspaceContext } from '../registry'
import { dedupePaths, isPathInside, normalizePathForCompare } from '../paths'
import { MAX_WATCH_PATHS, parseWatchPaths, watchChangedPath } from './logic'

const DEBOUNCE_MS = 200
// Linux 的 fs.watch 不支持 recursive；Windows/macOS 用递归监听项目根减少句柄。
const RECURSIVE_PLATFORMS = new Set(['win32', 'darwin'])

type WatchListener = (event: string, filename: string | Buffer | null) => void

interface CreatedWatcher {
  watcher: FSWatcher
  recursive: boolean
}

interface WatchState {
  watchers: FSWatcher[]
  pending: Map<string, string>
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
  const state: WatchState = { watchers: [], pending: new Map() }
  states.set(ctx, state)
  ctx.onClose(() => closeAll(state))
  return state
}

/** recursive 不被支持或被系统拒绝时退回单目录监听，至少保留基础刷新能力。 */
function createWatcher(
  target: string,
  isDir: boolean,
  wantRecursive: boolean,
  listener: WatchListener,
): CreatedWatcher {
  const plain = { persistent: false }
  if (!isDir || !wantRecursive) return { watcher: watch(target, plain, listener), recursive: false }
  try {
    return { watcher: watch(target, { ...plain, recursive: true }, listener), recursive: true }
  } catch {
    return { watcher: watch(target, plain, listener), recursive: false }
  }
}

/** 每次调用全量替换本连接的监听集合；变化 200ms 去抖后合并推送。 */
export async function fsWatch(
  p: Record<string, unknown>,
  ctx: WorkspaceContext,
): Promise<Record<string, never>> {
  const paths = parseWatchPaths(p)
  const state = stateFor(ctx)
  closeAll(state)

  const unique = dedupePaths(paths)
  if (unique.length > MAX_WATCH_PATHS) {
    ctx.log(`fs.watch 路径数 ${unique.length} 超过上限 ${MAX_WATCH_PATHS}，已截断`) // i18n-ignore: 仅进日志
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
  const wantRecursive = RECURSIVE_PLATFORMS.has(process.platform)
  const recursiveRoots: string[] = []
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!
    const isDir = dirFlags[index]
    if (isDir === null || isDir === undefined) {
      // 不存在的路径不监听：fs.watch 只会报错并占用一个 watcher。
      ctx.log('fs.watch 跳过不存在的路径') // i18n-ignore: 仅进日志
      continue
    }
    // 已被上层递归监听覆盖的路径不必再开一个句柄。
    if (recursiveRoots.some((root) => isPathInside(root, target))) continue
    try {
      const created = createWatcher(target, isDir, wantRecursive, (_event, filename) => {
        const changed = watchChangedPath(target, filename, isDir)
        const key = normalizePathForCompare(changed)
        if (!state.pending.has(key)) state.pending.set(key, changed)
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = setTimeout(() => {
          state.timer = undefined
          if (state.pending.size === 0) return
          const changedPaths = [...state.pending.values()]
          state.pending.clear()
          const payload: FsChangedEvt = { paths: changedPaths }
          ctx.emit('fs.changed', payload)
        }, DEBOUNCE_MS)
      })
      created.watcher.on('error', () => {
        ctx.log('fs.watch 监听出错，已关闭该监听') // i18n-ignore: 仅进日志
        created.watcher.close()
      })
      state.watchers.push(created.watcher)
      if (created.recursive) recursiveRoots.push(target)
    } catch (err) {
      ctx.log(`fs.watch 无法监听: ${err instanceof Error ? err.message : String(err)}`) // i18n-ignore: 仅进日志
    }
  }
  return {}
}
