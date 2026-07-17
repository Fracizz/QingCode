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
} from './terminalScrollbackSettings'

export const TERMINAL_SESSION_OUTPUT_KEY = 'qingcode:terminal-session-output'
export const TERMINAL_SESSION_OUTPUT_VERSION = 1 as const

export const MAX_COMMAND_HISTORY = 50
export const MAX_COMMAND_HISTORY_ENTRY_CHARS = 500
/** Soft ceiling for the whole JSON blob (localStorage quota safety). */
export const MAX_TERMINAL_OUTPUT_STORAGE_CHARS = 1_500_000

export type PersistedTerminalOutput = {
  scrollback: string
  history: string[]
  updatedAt: number
}

export type TerminalOutputSnapshot = {
  version: typeof TERMINAL_SESSION_OUTPUT_VERSION
  updatedAt: number
  terminals: Record<string, PersistedTerminalOutput>
}

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

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

function parseTerminalOutput(value: unknown): PersistedTerminalOutput | null {
  if (!isRecord(value)) return null
  if (typeof value.scrollback !== 'string') return null
  const maxLines = getTerminalScrollback()
  return {
    scrollback: truncateScrollbackText(value.scrollback, maxLines),
    history: normalizeCommandHistory(value.history),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
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
  terminals: Record<string, { scrollback: string; history: string[]; updatedAt?: number }>
  now?: number
  scrollbackLines?: number
}): TerminalOutputSnapshot {
  const maxLines = parseTerminalScrollback(input.scrollbackLines ?? getTerminalScrollback())
  const maxChars = scrollbackMaxChars(maxLines)
  const now = input.now ?? Date.now()
  const terminals: Record<string, PersistedTerminalOutput> = {}
  for (const [id, entry] of Object.entries(input.terminals)) {
    const scrollback = truncateScrollbackText(entry.scrollback, maxLines, maxChars)
    const history = normalizeCommandHistory(entry.history)
    if (!scrollback && history.length === 0) continue
    terminals[id] = {
      scrollback,
      history,
      updatedAt: entry.updatedAt ?? now,
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
