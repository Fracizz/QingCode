/**
 * Persist terminal scrollback + recent command history across app restarts.
 *
 * Tab metadata lives in `workspaceSessionPersist`; this module stores bulky
 * output separately so workspace snapshots stay small and storage can be
 * truncated aggressively against `terminal.integrated.scrollback`.
 */

import {
  getTerminalScrollback,
  parseTerminalScrollback,
  scrollbackMaxChars,
} from '@/lib/terminal/terminalScrollbackSettings'

export const TERMINAL_SESSION_OUTPUT_KEY = 'qingcode:terminal-session-output'
export const TERMINAL_SESSION_OUTPUT_VERSION = 1 as const

export const MAX_COMMAND_HISTORY = 50
export const MAX_COMMAND_HISTORY_ENTRY_CHARS = 500
/** Soft ceiling for the whole JSON blob (localStorage quota safety). */
export const MAX_TERMINAL_OUTPUT_STORAGE_CHARS = 1_500_000
/** 输出变化后等待合并的时间。 */
export const OUTPUT_PERSIST_DEBOUNCE_MS = 1_200
/** 持续输出时两次持久化的最小间隔，避免周期性同步写 localStorage 掉帧。 */
export const OUTPUT_PERSIST_MIN_INTERVAL_MS = 5_000

/** 下一次输出持久化应等待的毫秒数：至少防抖时长，且距上次持久化不少于最小间隔。 */
export function nextOutputPersistDelay(now: number, lastPersistAt: number): number {
  return Math.max(OUTPUT_PERSIST_DEBOUNCE_MS, lastPersistAt + OUTPUT_PERSIST_MIN_INTERVAL_MS - now)
}

/**
 * scrollback 开头那段按固定网格排版的屏幕：xterm 序列化出的已渲染画面，或 daemon 下发的快照。
 * 回放时必须先把视图改成这个网格再写入（序列化结果靠自动换行拼接折行），之后再 fit。
 * `chars` 是该段在 scrollback 字符串里的长度，其后是按原样追加的原始输出。
 */
export type PersistedTerminalScreen = { cols: number; rows: number; chars: number }

export type PersistedTerminalOutput = {
  scrollback: string
  history: string[]
  updatedAt: number
  /** daemon 终端在这份 scrollback 之后的续传序号；重启接回时只补发此后的输出。 */
  seq?: number
  screen?: PersistedTerminalScreen
}

export type TerminalOutputSnapshot = {
  version: typeof TERMINAL_SESSION_OUTPUT_VERSION
  updatedAt: number
  terminals: Record<string, PersistedTerminalOutput>
}

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

/**
 * Chunked byte ring for live terminal output.
 * Appends are O(1) amortized; flattening only happens for replay/persistence.
 */
export type TerminalByteRing = {
  chunks: Uint8Array[]
  headOffset: number
  byteLength: number
  maxBytes: number
}

export function createTerminalByteRing(
  maxBytes: number,
  initial?: Uint8Array,
): TerminalByteRing {
  const ring: TerminalByteRing = {
    chunks: [],
    headOffset: 0,
    byteLength: 0,
    maxBytes: Math.max(0, Math.floor(maxBytes)),
  }
  if (initial?.length) appendTerminalByteRing(ring, initial, maxBytes)
  return ring
}

export function appendTerminalByteRing(
  ring: TerminalByteRing,
  chunk: Uint8Array,
  maxBytes: number = ring.maxBytes,
): TerminalByteRing {
  const limit = Math.max(0, Math.floor(maxBytes))
  ring.maxBytes = limit
  if (limit === 0) {
    ring.chunks = []
    ring.headOffset = 0
    ring.byteLength = 0
    return ring
  }
  if (chunk.length >= limit) {
    ring.chunks = [chunk.slice(chunk.length - limit)]
    ring.headOffset = 0
    ring.byteLength = limit
    return ring
  }

  if (chunk.length > 0) {
    ring.chunks.push(chunk)
    ring.byteLength += chunk.length
  }
  let excess = ring.byteLength - limit
  while (excess > 0 && ring.chunks.length > 0) {
    const first = ring.chunks[0]
    const available = first.length - ring.headOffset
    if (excess >= available) {
      excess -= available
      ring.byteLength -= available
      ring.chunks.shift()
      ring.headOffset = 0
    } else {
      ring.headOffset += excess
      ring.byteLength -= excess
      excess = 0
    }
  }
  return ring
}

export function terminalByteRingToBytes(ring: TerminalByteRing | undefined): Uint8Array {
  if (!ring || ring.byteLength === 0) return new Uint8Array()
  const out = new Uint8Array(ring.byteLength)
  let offset = 0
  for (let index = 0; index < ring.chunks.length; index++) {
    const chunk = ring.chunks[index]
    const start = index === 0 ? ring.headOffset : 0
    const part = chunk.subarray(start)
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep the last `maxLines` newline-delimited lines, then cap total chars. */
export function truncateScrollbackText(
  text: string,
  maxLines: number,
  maxChars: number = scrollbackMaxChars(maxLines),
): string {
  if (!text) return ''
  const linesLimit = Math.max(0, Math.floor(maxLines))
  const charsLimit = Math.max(0, Math.floor(maxChars))
  if (linesLimit === 0 || charsLimit === 0) return ''

  let out = text.length > charsLimit ? text.slice(text.length - charsLimit) : text
  // Avoid keeping a partial first line after a char trim when possible.
  if (text.length > charsLimit) {
    const firstNl = out.indexOf('\n')
    if (firstNl >= 0 && firstNl < out.length - 1) out = out.slice(firstNl + 1)
  }

  const parts = out.split('\n')
  if (parts.length > linesLimit) {
    out = parts.slice(parts.length - linesLimit).join('\n')
  }
  return out
}

/** Truncate a live byte ring to the scrollback budget (decode → truncate → encode). */
export function truncateScrollbackBytes(
  bytes: Uint8Array,
  maxLines: number = getTerminalScrollback(),
  maxChars: number = scrollbackMaxChars(maxLines),
): Uint8Array {
  if (bytes.length === 0) return bytes
  if (bytes.length <= maxChars) {
    // Fast path: still enforce line budget when the payload is large enough to matter.
    const text = textDecoder.decode(bytes)
    const truncated = truncateScrollbackText(text, maxLines, maxChars)
    if (truncated.length === text.length) return bytes
    return textEncoder.encode(truncated)
  }
  const text = textDecoder.decode(bytes)
  return textEncoder.encode(truncateScrollbackText(text, maxLines, maxChars))
}

export function appendScrollbackBytes(
  previous: Uint8Array | undefined,
  chunk: Uint8Array,
  maxLines: number = getTerminalScrollback(),
  maxChars: number = scrollbackMaxChars(maxLines),
): Uint8Array {
  if (!previous || previous.length === 0) {
    return truncateScrollbackBytes(chunk, maxLines, maxChars)
  }
  if (chunk.length === 0) return truncateScrollbackBytes(previous, maxLines, maxChars)
  const merged = new Uint8Array(previous.length + chunk.length)
  merged.set(previous)
  merged.set(chunk, previous.length)
  return truncateScrollbackBytes(merged, maxLines, maxChars)
}

export function decodeScrollbackBytes(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.length === 0) return ''
  return textDecoder.decode(bytes)
}

export function encodeScrollbackText(text: string): Uint8Array {
  if (!text) return new Uint8Array()
  return textEncoder.encode(text)
}

export function normalizeCommandHistory(
  history: unknown,
  maxEntries: number = MAX_COMMAND_HISTORY,
): string[] {
  if (!Array.isArray(history)) return []
  const out: string[] = []
  for (const entry of history) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue
    out.push(trimmed.slice(0, MAX_COMMAND_HISTORY_ENTRY_CHARS))
  }
  return out.slice(-Math.max(0, maxEntries))
}

/** Append a completed command line (Enter) into a bounded history ring. */
export function pushCommandHistory(
  history: string[],
  command: string,
  maxEntries: number = MAX_COMMAND_HISTORY,
): string[] {
  const trimmed = command.replace(/\s+/g, ' ').trim().slice(0, MAX_COMMAND_HISTORY_ENTRY_CHARS)
  if (!trimmed) return history
  const next = history.length ? [...history, trimmed] : [trimmed]
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next
}

/**
 * Feed raw PTY/user keystrokes into a line accumulator; returns completed
 * commands when CR/LF is seen (shell echo is not required).
 */
export function absorbInputForHistory(
  pending: string,
  data: string,
): { pending: string; commands: string[] } {
  let line = pending
  const commands: string[] = []
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      if (line) {
        commands.push(line)
        line = ''
      }
      continue
    }
    if (ch === '\u007f' || ch === '\b') {
      line = line.slice(0, -1)
      continue
    }
    // Ignore other control characters.
    if (ch < ' ') continue
    line += ch
    if (line.length > MAX_COMMAND_HISTORY_ENTRY_CHARS) {
      line = line.slice(-MAX_COMMAND_HISTORY_ENTRY_CHARS)
    }
  }
  return { pending: line, commands }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function parsePersistedTerminalScreen(
  value: unknown,
  textLength: number,
): PersistedTerminalScreen | undefined {
  if (!isRecord(value)) return undefined
  if (!isPositiveInteger(value.cols) || !isPositiveInteger(value.rows)) return undefined
  if (!isPositiveInteger(value.chars) || value.chars > textLength) return undefined
  return { cols: value.cols, rows: value.rows, chars: value.chars }
}

/**
 * 从头截断 scrollback 后，开头屏幕段还剩多少。截掉的是最旧的行，剩下部分仍按原网格排版；
 * 整段被截掉时返回 undefined，余下的只是原始输出。
 */
export function screenAfterHeadTruncate(
  screen: PersistedTerminalScreen | undefined,
  before: number,
  after: number,
): PersistedTerminalScreen | undefined {
  if (!screen) return undefined
  const chars = screen.chars - Math.max(0, before - after)
  return chars > 0 ? { ...screen, chars } : undefined
}

function truncateWithScreen(
  scrollback: string,
  screen: PersistedTerminalScreen | undefined,
  maxLines: number,
  maxChars?: number,
): { scrollback: string; screen?: PersistedTerminalScreen } {
  const truncated = truncateScrollbackText(scrollback, maxLines, maxChars)
  const kept = screenAfterHeadTruncate(screen, scrollback.length, truncated.length)
  return { scrollback: truncated, ...(kept ? { screen: kept } : {}) }
}

function parseTerminalOutput(value: unknown): PersistedTerminalOutput | null {
  if (!isRecord(value)) return null
  if (typeof value.scrollback !== 'string') return null
  const maxLines = getTerminalScrollback()
  return {
    ...truncateWithScreen(
      value.scrollback,
      parsePersistedTerminalScreen(value.screen, value.scrollback.length),
      maxLines,
    ),
    history: normalizeCommandHistory(value.history),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    ...(typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0
      ? { seq: value.seq }
      : {}),
  }
}

export function parseTerminalOutputSnapshot(raw: unknown): TerminalOutputSnapshot | null {
  if (!isRecord(raw)) return null
  if (raw.version !== TERMINAL_SESSION_OUTPUT_VERSION) return null
  if (!isRecord(raw.terminals)) return null
  const terminals: Record<string, PersistedTerminalOutput> = {}
  for (const [id, entry] of Object.entries(raw.terminals)) {
    if (!id) continue
    const parsed = parseTerminalOutput(entry)
    if (!parsed) continue
    if (!parsed.scrollback && parsed.history.length === 0) continue
    terminals[id] = parsed
  }
  return {
    version: TERMINAL_SESSION_OUTPUT_VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    terminals,
  }
}

export function loadTerminalOutputSnapshot(): TerminalOutputSnapshot | null {
  try {
    const raw = localStorage.getItem(TERMINAL_SESSION_OUTPUT_KEY)
    if (!raw) return null
    return parseTerminalOutputSnapshot(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

function estimateSnapshotChars(snapshot: TerminalOutputSnapshot): number {
  let total = 64
  for (const entry of Object.values(snapshot.terminals)) {
    total += entry.scrollback.length + 32
    for (const cmd of entry.history) total += cmd.length + 4
  }
  return total
}

/** Drop oldest terminals until under the soft storage ceiling. */
export function enforceTerminalOutputStorageBudget(
  snapshot: TerminalOutputSnapshot,
  maxChars: number = MAX_TERMINAL_OUTPUT_STORAGE_CHARS,
): TerminalOutputSnapshot {
  if (estimateSnapshotChars(snapshot) <= maxChars) return snapshot
  const ranked = Object.entries(snapshot.terminals).sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt,
  )
  const terminals = { ...snapshot.terminals }
  while (ranked.length > 0 && estimateSnapshotChars({ ...snapshot, terminals }) > maxChars) {
    const [id] = ranked.shift()!
    delete terminals[id]
  }
  return { ...snapshot, terminals }
}

export function saveTerminalOutputSnapshot(snapshot: TerminalOutputSnapshot): void {
  const capped = enforceTerminalOutputStorageBudget({
    ...snapshot,
    version: TERMINAL_SESSION_OUTPUT_VERSION,
    updatedAt: snapshot.updatedAt || Date.now(),
  })
  try {
    localStorage.setItem(TERMINAL_SESSION_OUTPUT_KEY, JSON.stringify(capped))
  } catch {
    // Quota — drop half of the oldest entries and retry once.
    const ranked = Object.entries(capped.terminals).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    )
    const keep = ranked.slice(Math.ceil(ranked.length / 2))
    const shrunk: TerminalOutputSnapshot = {
      version: TERMINAL_SESSION_OUTPUT_VERSION,
      updatedAt: Date.now(),
      terminals: Object.fromEntries(keep),
    }
    try {
      localStorage.setItem(TERMINAL_SESSION_OUTPUT_KEY, JSON.stringify(shrunk))
    } catch {
      /* ignore */
    }
  }
}

export function clearTerminalOutputSnapshot(): void {
  try {
    localStorage.removeItem(TERMINAL_SESSION_OUTPUT_KEY)
  } catch {
    /* ignore */
  }
}

export function buildTerminalOutputSnapshot(input: {
  terminals: Record<
    string,
    {
      scrollback: string
      history: string[]
      updatedAt?: number
      seq?: number
      screen?: PersistedTerminalScreen
    }
  >
  now?: number
  scrollbackLines?: number
}): TerminalOutputSnapshot {
  const maxLines = parseTerminalScrollback(input.scrollbackLines ?? getTerminalScrollback())
  const maxChars = scrollbackMaxChars(maxLines)
  const now = input.now ?? Date.now()
  const terminals: Record<string, PersistedTerminalOutput> = {}
  for (const [id, entry] of Object.entries(input.terminals)) {
    const { scrollback, screen } = truncateWithScreen(
      entry.scrollback,
      entry.screen,
      maxLines,
      maxChars,
    )
    const history = normalizeCommandHistory(entry.history)
    if (!scrollback && history.length === 0) continue
    terminals[id] = {
      scrollback,
      history,
      updatedAt: entry.updatedAt ?? now,
      ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
      ...(screen ? { screen } : {}),
    }
  }
  return enforceTerminalOutputStorageBudget({
    version: TERMINAL_SESSION_OUTPUT_VERSION,
    updatedAt: now,
    terminals,
  })
}

/** Remove output for closed tabs; keep only `keepIds` when provided. */
export function pruneTerminalOutputSnapshot(
  snapshot: TerminalOutputSnapshot,
  keepIds: Iterable<string>,
): TerminalOutputSnapshot {
  const keep = new Set(keepIds)
  const terminals: Record<string, PersistedTerminalOutput> = {}
  for (const [id, entry] of Object.entries(snapshot.terminals)) {
    if (keep.has(id)) terminals[id] = entry
  }
  return { ...snapshot, terminals, updatedAt: Date.now() }
}
