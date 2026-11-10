/**
 * 终端输出缓冲：每个终端的输出 ring、视图订阅与批量刷新、屏幕快照、命令历史，
 * 以及 scrollback 的持久化调度。模块级状态在整个应用中只有这一份。
 * 从 terminalStore 拆出，对外 API 仍由 terminalStore 统一重新导出。
 */
import {
  absorbInputForHistory,
  appendTerminalByteRing,
  buildTerminalOutputSnapshot,
  createTerminalByteRing,
  decodeScrollbackBytes,
  encodeScrollbackText,
  loadTerminalOutputSnapshot,
  nextOutputPersistDelay,
  pushCommandHistory,
  saveTerminalOutputSnapshot,
  terminalByteRingToBytes,
  type TerminalByteRing,
  truncateScrollbackBytes,
} from '@/lib/terminal/terminalSessionPersist'
import {
  getTerminalScrollback,
  scrollbackMaxChars,
} from '@/lib/terminal/terminalScrollbackSettings'
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from '@/lib/terminal/terminalPtySize'
import { clearTerminalCommandActivity } from '@/lib/terminal/terminalCommandActivity'
import { clearTerminalProgramActivity } from '@/lib/terminal/terminalProgramActivity'
import { isSessionPersistEnabled } from '../../lib/sessionPersistSettings'
import {
  finishTerminalMirror,
  forwardTerminalMirrorOutput,
  forwardTerminalMirrorScreen,
  terminalCapture,
  type TerminalCapture,
} from '../../lib/terminal/terminalMirror'
import { recordPerformanceThroughput } from '../../lib/performanceDiagnostics'
import { decodeTerminalEventData } from '../../utils/terminalIpc'
import { useTerminalControlStore } from '../terminalControlStore'
import { useTerminalDraftStore } from '../terminalDraftStore'
import { lastPtySize } from './ptySizing'

/**
 * 持久化时需要按标签顺序列出现有终端 id；由 terminalStore 创建后注册，
 * 避免本模块反向依赖 terminalStore。
 */
let outputPersistTerminalIds: (() => Iterable<string>) | null = null

export function registerTerminalOutputPersistSource(source: () => Iterable<string>) {
  outputPersistTerminalIds = source
}

const OUTPUT_PERSIST_IDLE_TIMEOUT_MS = 4_000
export type TerminalOutputListener = (data: Uint8Array) => void

/** Always-on ring used for persistence + restore replay. */
const terminalScrollbackRings = new Map<string, TerminalByteRing>()
const terminalCommandHistory = new Map<string, string[]>()
export const terminalInputPending = new Map<string, string>()
const terminalOutputListeners = new Map<string, Set<TerminalOutputListener>>()
const terminalRingUpdatedAt = new Map<string, number>()
const terminalPendingOutput = new Map<string, Uint8Array[]>()
const terminalOutputFlushTimers = new Map<string, number>()
const terminalOutputFlushRafIds = new Set<string>()

/**
 * 带网格的屏幕快照，对应 VS Code pty host 接回时下发的 ReplayEntry（cols/rows/data）：
 * 快照按产生时的网格排版，接收方必须先按该网格写入，再 resize 到自身尺寸。
 */
export interface TerminalViewSnapshot {
  data: string
  cols: number
  rows: number
}
export type TerminalScreenListener = (snapshot: TerminalViewSnapshot) => void
/** 已挂载视图接收屏幕快照的回调（daemon 接回时下发，见 applyTerminalScreen）。 */
const terminalScreenListeners = new Map<string, Set<TerminalScreenListener>>()

function addTerminalScreenListener(id: string, listener: TerminalScreenListener) {
  const listeners = terminalScreenListeners.get(id) ?? new Set<TerminalScreenListener>()
  listeners.add(listener)
  terminalScreenListeners.set(id, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && terminalScreenListeners.get(id) === listeners) {
      terminalScreenListeners.delete(id)
    }
  }
}

/**
 * daemon 终端的续传序号：ring 里最后一个字节之后的输出序号，随输出一起持久化。
 * 应用重启后接回时带给 daemon，只补发断线期间的输出（见 attachTerminal 的 fromSeq）。
 */
export const terminalResumeSeqs = new Map<string, number>()

function parseResumeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * ring 里最近一次屏幕快照的位置：快照字节数与其后又追加的字节数。
 * 快照到达时视图可能还没挂载（本次启动后没打开过的项目），挂载回放时据此把快照
 * 交给视图按快照网格写入，而不是当普通字节写进当前网格。
 */
const terminalRingScreens = new Map<
  string,
  { snapshot: TerminalViewSnapshot; size: number; after: number }
>()

/**
 * daemon 接回时下发的屏幕快照。直接当普通输出写进尺寸不同的 xterm 会逐行错位，
 * 所以交给视图按快照网格写入后再 fit 重绘（同 VS Code 处理 replay 事件）。ring 也追加
 * 快照字节，供持久化与尚未挂载的视图回放（见 subscribeTerminalOutput）。
 */
export function applyTerminalScreen(id: string, snapshot: TerminalViewSnapshot, resumeSeq?: number) {
  // 先把批处理中的输出交给视图，保证快照排在它们之后。
  if (terminalPendingOutput.has(id)) flushTerminalOutput(id)
  forwardTerminalMirrorScreen(id, snapshot)
  const bytes = new TextEncoder().encode(snapshot.data)
  if (resumeSeq !== undefined) terminalResumeSeqs.set(id, resumeSeq)
  touchRing(id, bytes)
  terminalRingScreens.set(id, { snapshot, size: bytes.length, after: 0 })
  terminalScreenListeners.get(id)?.forEach(listener => listener(snapshot))
}

export function parseTerminalScreenPayload(
  payload: unknown
): ({ id: string; nextSeq?: number } & TerminalViewSnapshot) | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const isSize = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0
  if (typeof record.id !== 'string' || typeof record.data !== 'string') return null
  if (!isSize(record.cols) || !isSize(record.rows)) return null
  return {
    id: record.id,
    data: record.data,
    cols: record.cols,
    rows: record.rows,
    nextSeq: parseResumeSeq(record.nextSeq),
  }
}

/** ring 每次变化递增；持久化时只重新解码版本变化的终端。 */
const terminalRingVersions = new Map<string, number>()
const terminalScrollbackTextCache = new Map<string, { version: number; text: string }>()

let outputPersistTimer: ReturnType<typeof setTimeout> | null = null
let outputPersistIdle: number | null = null
let lastOutputPersistAt = 0

function bumpRingVersion(id: string) {
  terminalRingVersions.set(id, (terminalRingVersions.get(id) ?? 0) + 1)
}

function cachedScrollbackText(id: string): string {
  const version = terminalRingVersions.get(id) ?? 0
  const cached = terminalScrollbackTextCache.get(id)
  if (cached && cached.version === version) return cached.text
  const text = decodeScrollbackBytes(terminalByteRingToBytes(terminalScrollbackRings.get(id)))
  terminalScrollbackTextCache.set(id, { version, text })
  return text
}

/** 未打开过的项目没有 xterm 实例，CLI 用这份原始输出（含控制序列）兜底。 */
export function getTerminalRawScrollback(id: string): string {
  return cachedScrollbackText(id)
}

function maxBufferedBytes(): number {
  return scrollbackMaxChars(getTerminalScrollback())
}

function touchRing(id: string, bytes: Uint8Array) {
  const maxBytes = maxBufferedBytes()
  const ring =
    terminalScrollbackRings.get(id) ?? createTerminalByteRing(maxBytes)
  appendTerminalByteRing(ring, bytes, maxBytes)
  terminalScrollbackRings.set(id, ring)
  terminalRingUpdatedAt.set(id, Date.now())
  bumpRingVersion(id)
  scheduleTerminalOutputPersist()
}

function combineOutputChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

function cancelScheduledOutputFlush(id: string) {
  const handle = terminalOutputFlushTimers.get(id)
  if (handle === undefined) return
  if (terminalOutputFlushRafIds.delete(id)) {
    cancelAnimationFrame(handle)
  } else {
    clearTimeout(handle)
  }
  terminalOutputFlushTimers.delete(id)
}

function flushTerminalOutput(id: string) {
  cancelScheduledOutputFlush(id)
  const chunks = terminalPendingOutput.get(id)
  terminalPendingOutput.delete(id)
  if (!chunks?.length) return
  const listeners = terminalOutputListeners.get(id)
  if (!listeners?.size) return
  const combined = combineOutputChunks(chunks)
  listeners.forEach(listener => listener(combined))
}

function scheduleTerminalOutputFlush(id: string) {
  if (terminalOutputFlushTimers.has(id)) return
  const run = () => {
    terminalOutputFlushTimers.delete(id)
    terminalOutputFlushRafIds.delete(id)
    flushTerminalOutput(id)
  }
  if (typeof requestAnimationFrame === 'function') {
    terminalOutputFlushRafIds.add(id)
    terminalOutputFlushTimers.set(id, requestAnimationFrame(run))
  } else {
    terminalOutputFlushTimers.set(id, window.setTimeout(run, 0))
  }
}

function queueTerminalOutput(id: string, bytes: Uint8Array) {
  const chunks = terminalPendingOutput.get(id) ?? []
  chunks.push(bytes)
  terminalPendingOutput.set(id, chunks)
  scheduleTerminalOutputFlush(id)
}

export function publishTerminalOutput(id: string, data: unknown, nextSeq?: unknown) {
  const bytes = decodeTerminalEventData(data)
  if (!bytes) return
  recordPerformanceThroughput('terminalBytes', bytes.length)
  forwardTerminalMirrorOutput(id, bytes)
  // 与 ring 同步更新，持久化时两者对应同一时刻。
  const resumeSeq = parseResumeSeq(nextSeq)
  if (resumeSeq !== undefined) terminalResumeSeqs.set(id, resumeSeq)
  touchRing(id, bytes)
  const screen = terminalRingScreens.get(id)
  if (screen) screen.after += bytes.length

  const listeners = terminalOutputListeners.get(id)
  if (listeners?.size) {
    queueTerminalOutput(id, bytes)
  }
}

export function clearTerminalOutput(id: string, options?: { persist?: boolean }) {
  finishTerminalMirror(id, 0, false)
  useTerminalControlStore.getState().clearControl(id)
  useTerminalDraftStore.getState().clearDraft(id)
  terminalScrollbackRings.delete(id)
  terminalRingScreens.delete(id)
  terminalResumeSeqs.delete(id)
  terminalPendingOutput.delete(id)
  cancelScheduledOutputFlush(id)
  terminalCommandHistory.delete(id)
  terminalInputPending.delete(id)
  terminalRingUpdatedAt.delete(id)
  terminalRingVersions.delete(id)
  terminalScrollbackTextCache.delete(id)
  clearTerminalCommandActivity(id)
  clearTerminalProgramActivity(id)
  if (options?.persist !== false) scheduleTerminalOutputPersist()
}

/** Seed live rings from durable storage (called during workspace hydrate). */
export function seedTerminalOutputFromPersist(
  id: string,
  scrollback: string,
  history: string[] = [],
  resumeSeq?: number
) {
  if (scrollback) {
    // 续传序号只对这份 scrollback 有意义，两者一起恢复。
    if (resumeSeq !== undefined) terminalResumeSeqs.set(id, resumeSeq)
    const bytes = truncateScrollbackBytes(
      encodeScrollbackText(scrollback),
      getTerminalScrollback(),
      maxBufferedBytes()
    )
    terminalScrollbackRings.set(id, createTerminalByteRing(maxBufferedBytes(), bytes))
    terminalRingUpdatedAt.set(id, Date.now())
    bumpRingVersion(id)
  }
  if (history.length > 0) {
    terminalCommandHistory.set(id, [...history])
  }
}

/** Hydrate all persisted scrollback/history entries that match known tab ids. */
export function hydrateTerminalOutputForTabs(terminalIds: Iterable<string>) {
  if (!isSessionPersistEnabled()) return
  const snapshot = loadTerminalOutputSnapshot()
  if (!snapshot) return
  const wanted = new Set(terminalIds)
  for (const [id, entry] of Object.entries(snapshot.terminals)) {
    if (!wanted.has(id)) continue
    seedTerminalOutputFromPersist(id, entry.scrollback, entry.history, entry.seq)
  }
}


/**
 * 订阅终端输出。新视图先拿到一次完整的 ring 回放；传入 `onScreen` 时还会收到 daemon
 * 下发的带网格屏幕快照（见 applyTerminalScreen）。
 */
export function subscribeTerminalOutput(
  id: string,
  listener: TerminalOutputListener,
  onScreen?: TerminalScreenListener
) {
  // Deliver already-batched live bytes to existing views before a new view replays the ring.
  // This avoids both missing history and duplicating the pending tail in the new xterm.
  if (terminalPendingOutput.has(id)) flushTerminalOutput(id)
  const listeners = terminalOutputListeners.get(id) ?? new Set<TerminalOutputListener>()
  listeners.add(listener)
  terminalOutputListeners.set(id, listeners)
  const removeScreenListener = onScreen ? addTerminalScreenListener(id, onScreen) : undefined

  // A newly mounted xterm needs one complete replay. Live output is batched below.
  const ring = terminalByteRingToBytes(terminalScrollbackRings.get(id))
  const screen = onScreen ? terminalRingScreens.get(id) : undefined
  const before = screen ? ring.length - screen.size - screen.after : -1
  if (onScreen && screen && before >= 0) {
    // 快照仍完整留在 ring 里：前段历史照常回放，快照按自身网格交给视图，再接上之后的输出。
    if (before > 0) listener(ring.subarray(0, before))
    onScreen(screen.snapshot)
    if (screen.after > 0) listener(ring.subarray(ring.length - screen.after))
  } else if (ring.length) {
    listener(ring)
  }

  return () => {
    removeScreenListener?.()
    listeners.delete(listener)
    if (listeners.size === 0) {
      terminalOutputListeners.delete(id)
      terminalPendingOutput.delete(id)
      cancelScheduledOutputFlush(id)
    }
  }
}

function collectOutputPersistPayload(terminalIds: Iterable<string>): Record<
  string,
  { scrollback: string; history: string[]; updatedAt?: number; seq?: number }
> {
  const terminals: Record<
    string,
    { scrollback: string; history: string[]; updatedAt?: number; seq?: number }
  > = {}
  for (const id of terminalIds) {
    const scrollback = cachedScrollbackText(id)
    const history = terminalCommandHistory.get(id) ?? []
    if (!scrollback && history.length === 0) continue
    terminals[id] = {
      scrollback,
      history,
      updatedAt: terminalRingUpdatedAt.get(id),
      seq: terminalResumeSeqs.get(id),
    }
  }
  return terminals
}

export function persistTerminalOutputNow() {
  if (outputPersistTimer) {
    clearTimeout(outputPersistTimer)
    outputPersistTimer = null
  }
  if (outputPersistIdle !== null) {
    if (typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(outputPersistIdle)
    }
    outputPersistIdle = null
  }
  if (!isSessionPersistEnabled()) return
  // terminalStore 尚未注册数据源时不写盘，避免用空列表覆盖已保存的输出。
  if (!outputPersistTerminalIds) return
  lastOutputPersistAt = Date.now()
  const terminals = collectOutputPersistPayload(outputPersistTerminalIds())
  const snapshot = buildTerminalOutputSnapshot({
    terminals,
    scrollbackLines: getTerminalScrollback(),
  })
  saveTerminalOutputSnapshot(snapshot)
}

export function scheduleTerminalOutputPersist() {
  if (outputPersistTimer || outputPersistIdle !== null) return
  outputPersistTimer = setTimeout(() => {
    outputPersistTimer = null
    if (typeof window.requestIdleCallback === 'function') {
      outputPersistIdle = window.requestIdleCallback(
        () => {
          outputPersistIdle = null
          persistTerminalOutputNow()
        },
        { timeout: OUTPUT_PERSIST_IDLE_TIMEOUT_MS },
      )
    } else {
      persistTerminalOutputNow()
    }
  }, nextOutputPersistDelay(Date.now(), lastOutputPersistAt))
}

export function recordTypedInput(id: string, data: string) {
  const { pending, commands } = absorbInputForHistory(terminalInputPending.get(id) ?? '', data)
  terminalInputPending.set(id, pending)
  if (commands.length === 0) return
  let history = terminalCommandHistory.get(id) ?? []
  for (const command of commands) {
    history = pushCommandHistory(history, command)
  }
  terminalCommandHistory.set(id, history)
  scheduleTerminalOutputPersist()
}

/** True when the ring still has bytes (used by Terminal UI for restore banners). */
export function hasTerminalScrollback(id: string): boolean {
  const ring = terminalScrollbackRings.get(id)
  return !!ring && ring.byteLength > 0
}

/**
 * 抓取手机接入时的初始画面，必须和 `beginTerminalMirror` 在同一轮同步代码里调用：
 * 此前的输出都进入快照，此后的输出都进入转发队列，两边不重不漏。
 */
export function captureTerminalForMirror(id: string): Promise<TerminalCapture> {
  if (terminalPendingOutput.has(id)) flushTerminalOutput(id)
  const capture = terminalCapture(id)
  if (capture) return capture()
  // 视图尚未挂载（恢复后没打开过的标签）时用输出缓存代替。
  const size = lastPtySize.get(id) ?? { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS }
  const data = new TextDecoder().decode(terminalByteRingToBytes(terminalScrollbackRings.get(id)))
  return Promise.resolve({ data, cols: size.cols, rows: size.rows })
}
