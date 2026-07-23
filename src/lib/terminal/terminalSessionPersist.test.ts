import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_COMMAND_HISTORY,
  TERMINAL_SESSION_OUTPUT_KEY,
  absorbInputForHistory,
  appendScrollbackBytes,
  buildTerminalOutputSnapshot,
  clearTerminalOutputSnapshot,
  enforceTerminalOutputStorageBudget,
  loadTerminalOutputSnapshot,
  normalizeCommandHistory,
  parseTerminalOutputSnapshot,
  pruneTerminalOutputSnapshot,
  pushCommandHistory,
  saveTerminalOutputSnapshot,
  truncateScrollbackBytes,
  truncateScrollbackText,
} from '@/lib/terminal/terminalSessionPersist'
import { notifyTerminalScrollbackChanged } from '@/lib/terminal/terminalScrollbackSettings'

function installMemoryLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  })
}

beforeEach(() => {
  installMemoryLocalStorage()
  notifyTerminalScrollbackChanged(5000)
})

afterEach(() => {
  clearTerminalOutputSnapshot()
  vi.unstubAllGlobals()
})

describe('truncateScrollbackText', () => {
  it('keeps the last N lines and respects char budget', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')
    expect(truncateScrollbackText(text, 3)).toBe('line-17\nline-18\nline-19')
    expect(truncateScrollbackText('abcdefghij', 100, 4)).toBe('ghij')
  })

  it('returns empty for zero budgets', () => {
    expect(truncateScrollbackText('hello', 0)).toBe('')
    expect(truncateScrollbackText('hello', 10, 0)).toBe('')
  })
})

describe('truncateScrollbackBytes / appendScrollbackBytes', () => {
  it('appends and truncates by line budget', () => {
    const enc = new TextEncoder()
    const a = enc.encode('one\ntwo\n')
    const b = enc.encode('three\nfour')
    const merged = appendScrollbackBytes(a, b, 2, 10_000)
    expect(new TextDecoder().decode(merged)).toBe('three\nfour')
    expect(truncateScrollbackBytes(enc.encode('a\nb\nc'), 2, 10_000)).toEqual(
      enc.encode('b\nc'),
    )
  })
})

describe('command history helpers', () => {
  it('normalizes and caps history entries', () => {
    expect(normalizeCommandHistory(['  ls  ', '', 1, 'x'.repeat(600)])).toEqual([
      'ls',
      'x'.repeat(500),
    ])
    const filled = Array.from({ length: MAX_COMMAND_HISTORY + 5 }, (_, i) => `c${i}`)
    const pushed = pushCommandHistory(filled.slice(0, MAX_COMMAND_HISTORY), 'new')
    expect(pushed[pushed.length - 1]).toBe('new')
    expect(pushCommandHistory(filled.slice(0, MAX_COMMAND_HISTORY), 'new')).toHaveLength(
      MAX_COMMAND_HISTORY,
    )
  })

  it('absorbs keystrokes into completed commands', () => {
    const first = absorbInputForHistory('', 'ech')
    expect(first.commands).toEqual([])
    const second = absorbInputForHistory(first.pending, 'o\r')
    expect(second.commands).toEqual(['echo'])
    expect(second.pending).toBe('')
    const backspace = absorbInputForHistory('ab', '\b\bc\n')
    expect(backspace.commands).toEqual(['c'])
  })
})

describe('parse / persist snapshot', () => {
  it('rejects bad versions and keeps valid terminals', () => {
    expect(parseTerminalOutputSnapshot(null)).toBeNull()
    expect(parseTerminalOutputSnapshot({ version: 2, terminals: {} })).toBeNull()
    const parsed = parseTerminalOutputSnapshot({
      version: 1,
      updatedAt: 9,
      terminals: {
        t1: { scrollback: 'hello\n', history: ['ls'], updatedAt: 1 },
        bad: { scrollback: 1 },
      },
    })
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!.terminals)).toEqual(['t1'])
    expect(parsed!.terminals.t1.history).toEqual(['ls'])
  })

  it('roundtrips through localStorage', () => {
    const snapshot = buildTerminalOutputSnapshot({
      terminals: {
        t1: { scrollback: 'out\n', history: ['pwd'], updatedAt: 3 },
      },
      now: 11,
      scrollbackLines: 100,
    })
    saveTerminalOutputSnapshot(snapshot)
    expect(localStorage.getItem(TERMINAL_SESSION_OUTPUT_KEY)).toBeTruthy()
    expect(loadTerminalOutputSnapshot()).toEqual(snapshot)
  })

  it('prunes closed terminals and enforces storage budget', () => {
    const snapshot = buildTerminalOutputSnapshot({
      terminals: {
        keep: { scrollback: 'a', history: [], updatedAt: 2 },
        drop: { scrollback: 'b', history: [], updatedAt: 1 },
      },
      now: 5,
    })
    const pruned = pruneTerminalOutputSnapshot(snapshot, ['keep'])
    expect(Object.keys(pruned.terminals)).toEqual(['keep'])

    const bulky = buildTerminalOutputSnapshot({
      terminals: {
        old: { scrollback: 'x'.repeat(1000), history: [], updatedAt: 1 },
        mid: { scrollback: 'y'.repeat(1000), history: [], updatedAt: 2 },
        new: { scrollback: 'z'.repeat(1000), history: [], updatedAt: 3 },
      },
      now: 9,
    })
    const capped = enforceTerminalOutputStorageBudget(bulky, 2500)
    expect(capped.terminals.old).toBeUndefined()
    expect(capped.terminals.new).toBeDefined()
  })
})
