/**
 * PTY 尺寸管理：记住每个终端最近下发的尺寸与视图网格、按最小间隔节流 resize、
 * 在新建/接回请求在途时暂存待补发的同步，以及 xterm 迟迟不 fit 时的兜底启动计时。
 * 从 terminalStore 拆出，模块级状态在整个应用中只有这一份。
 */
import { resizeTerminal } from '../../lib/ipc/terminal'
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  normalizePtySize,
} from '@/lib/terminal/terminalPtySize'
import { noteTerminalInput } from '@/lib/terminal/terminalProgramActivity'

/** If xterm never reports a size (panel closed), spawn with defaults. */
const PTY_SPAWN_FALLBACK_MS = 2500
const ptySpawnFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Last fitted size per tab — used when restarting before the next fit. */
export const lastPtySize = new Map<string, { cols: number; rows: number }>()
/**
 * 新建/接回请求在途时后端还没登记该终端，期间的 resize 与重绘都下发不到
 * （SSH 报「终端不存在」），而之后同尺寸的 resize 又会被去重，PTY 停在请求时的尺寸、
 * 全屏 TUI 的残留画面也没人重画。先记下，请求完成后补发（见 flushDeferredPtySync）。
 */
export const deferredPtySync = new Map<string, { size?: { cols: number; rows: number }; redraw?: boolean }>()

export function clearPtySpawnFallback(id: string) {
  const timer = ptySpawnFallbackTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    ptySpawnFallbackTimers.delete(id)
  }
}

export function rememberPtySize(id: string, cols: number, rows: number) {
  lastPtySize.set(id, normalizePtySize(cols, rows))
}

/**
 * 同一 PTY 两次改尺寸的最小间隔。ConPTY 下的全屏 TUI（OpenCode 实测约 100ms）要过一会
 * 才响应尺寸变化：中间尺寸停留太短时 TUI 来不及按它重画，conhost 却已按它裁掉缓冲区，
 * 回到原尺寸后 TUI 的差量渲染认为画面没变、不再重画，于是整屏错位且再抖动也修不回来。
 * 实测 80ms 不够、150ms 可以，留余量取 300ms（与视图侧 resize 合并窗口一致）。
 */
const PTY_RESIZE_MIN_GAP_MS = 300
/** 每个终端最近一次真正改动 PTY 尺寸的时间（新建/接回按请求尺寸算一次）。 */
const ptySizeChangedAt = new Map<string, number>()
/** 等待间隔期间排队的尺寸：只保留最新的一次。 */
const pacedPtyResizes = new Map<string, { size: { cols: number; rows: number }; done: Promise<void> }>()

export function markPtySizeChanged(id: string) {
  ptySizeChangedAt.set(id, Date.now())
  // 改尺寸后 ConPTY/TUI 会整屏重绘，这段输出不算程序在工作。
  noteTerminalInput(id)
}

function ptyResizeWaitMs(id: string): number {
  const last = ptySizeChangedAt.get(id)
  if (last === undefined) return 0
  // 封顶：系统时钟回拨时不至于等出远超间隔的时长。
  return Math.min(PTY_RESIZE_MIN_GAP_MS, Math.max(0, last + PTY_RESIZE_MIN_GAP_MS - Date.now()))
}

/** 按最小间隔把尺寸交给 PTY；间隔内再来的尺寸合并成最新一次。 */
export function sendPtySizePaced(id: string, size: { cols: number; rows: number }): Promise<void> {
  const queued = pacedPtyResizes.get(id)
  if (queued) {
    queued.size = size
    return queued.done
  }
  const wait = ptyResizeWaitMs(id)
  if (wait === 0) {
    markPtySizeChanged(id)
    return resizeTerminal(id, size.cols, size.rows)
  }
  const entry = { size, done: Promise.resolve() }
  entry.done = new Promise<void>(resolve => setTimeout(resolve, wait)).then(() => {
    pacedPtyResizes.delete(id)
    markPtySizeChanged(id)
    return resizeTerminal(id, entry.size.cols, entry.size.rows)
  })
  pacedPtyResizes.set(id, entry)
  return entry.done
}

/**
 * 已挂载且有真实尺寸的终端视图当前的字符网格（视图 fit 后登记，卸载时清除）。
 * 应用重启后 lastPtySize 是空的，恢复/兜底启动若直接用 80x24，接回前对齐网格会把 PTY
 * 真的改成 80x24：快照按 80x24 下发，视图要先缩到 80x24 写快照再 fit 回去，期间 TUI 按
 * 实际尺寸的重绘若先到，就被裁在左上角 80x24 里（应用启动时界面繁忙、fit 推迟，
 * 启动即接回的当前项目最容易碰上）。
 */
export const terminalViewGrids = new Map<string, { cols: number; rows: number }>()

export function setTerminalViewGrid(id: string, size: { cols: number; rows: number } | null) {
  if (size) terminalViewGrids.set(id, normalizePtySize(size.cols, size.rows))
  else terminalViewGrids.delete(id)
}

/** 启动/接回在拿不到视图 fit 回调时用的尺寸：视图网格 → 上次下发的尺寸 → 默认。 */
export function preferredSpawnSize(id: string): { cols: number; rows: number } {
  return (
    terminalViewGrids.get(id) ??
    lastPtySize.get(id) ?? { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS }
  )
}

export function deferPtySync(id: string, update: { size?: { cols: number; rows: number }; redraw?: boolean }) {
  const current = deferredPtySync.get(id) ?? {}
  deferredPtySync.set(id, {
    size: update.size ?? current.size,
    redraw: current.redraw || update.redraw,
  })
}

/**
 * 请求在途期间被推迟的同步：尺寸变了就补一次真实 resize（ConPTY/TUI 会随之整屏重绘），
 * 否则只在接回时补一次重绘。
 */
export function planDeferredPtySync(
  spawned: { cols: number; rows: number } | null,
  deferred: { size?: { cols: number; rows: number }; redraw?: boolean } | undefined,
  attached: boolean
): { action: 'resize' | 'redraw'; cols: number; rows: number } | null {
  if (!deferred) return null
  const size = deferred.size ?? spawned
  // 沿用 PTY 尺寸接回（spawned 为空）且期间没有视图网格：等视图 fit 后自然下发。
  if (!size) return null
  if (!spawned || size.cols !== spawned.cols || size.rows !== spawned.rows) {
    return { action: 'resize', ...size }
  }
  return deferred.redraw && attached ? { action: 'redraw', ...size } : null
}

export function schedulePtySpawnFallback(id: string, spawn: () => void) {
  clearPtySpawnFallback(id)
  ptySpawnFallbackTimers.set(
    id,
    setTimeout(() => {
      ptySpawnFallbackTimers.delete(id)
      spawn()
    }, PTY_SPAWN_FALLBACK_MS)
  )
}
