import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  clearTerminalOutput,
  hydrateTerminalOutputForTabs,
  persistTerminalOutputNow,
  publishTerminalOutput,
  registerTerminalOutputPersistSource,
  subscribeTerminalOutput,
  terminalResumeSeqs,
  type TerminalViewSnapshot,
} from './outputBuffer'
import {
  TERMINAL_SESSION_OUTPUT_KEY,
  loadTerminalOutputSnapshot,
} from '@/lib/terminal/terminalSessionPersist'
import { registerTerminalPersistCapture } from '@/lib/terminal/terminalMirror'
import { notifyTerminalScrollbackChanged } from '@/lib/terminal/terminalScrollbackSettings'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function installMemoryLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  })
}

/** 行内 TUI 的一帧：先按上一帧的行数光标上移擦除，再画转圈行、状态行和输入行。 */
function liveFrame(index: number, first: boolean): string {
  const erase = first ? '' : '\r\x1b[2K' + '\x1b[1A\x1b[2K'.repeat(2)
  return `${erase}* Working ${index}s\r\n  status ${index}\r\n> `
}

/** 把一帧擦掉后提交一行静态输出，再重画实时区域，与 Claude Code 写入工具结果的方式相同。 */
function commitLine(index: number): string {
  return `\r\x1b[2K${'\x1b[1A\x1b[2K'.repeat(2)}done ${index}\r\n${liveFrame(index, true)}`
}

function tuiStream(from: number, to: number, first: boolean): string {
  let out = ''
  for (let index = from; index < to; index++) {
    out += index % 7 === 0 ? commitLine(index) : liveFrame(index, first && index === from)
  }
  return out
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise(resolve => term.write(data, resolve))
}

function lines(term: Terminal): string[] {
  const buffer = term.buffer.active
  const out: string[] = []
  for (let row = 0; row < buffer.length; row++) {
    out.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return out
}

describe('inline TUI restore', () => {
  it('replays the serialized screen so later incremental frames land in place', async () => {
    const live = new Terminal({ cols: 60, rows: 10, scrollback: 1000, allowProposedApi: true })
    const serialize = new SerializeAddon()
    live.loadAddon(serialize)
    await write(live, tuiStream(0, 200, true))

    const restored = new Terminal({ cols: 60, rows: 10, scrollback: 1000, allowProposedApi: true })
    await write(restored, serialize.serialize({ scrollback: 1000 }))
    await write(live, tuiStream(200, 220, false))
    await write(restored, tuiStream(200, 220, false))

    const expected = lines(live).slice(-10)
    expect(lines(restored).slice(-10)).toEqual(expected)
    expect(lines(restored).filter(line => line.startsWith('* Working'))).toHaveLength(1)
  })
})

describe('terminal output persistence with rendered screens', () => {
  const id = 'screen-tab'

  beforeEach(() => {
    installMemoryLocalStorage()
    notifyTerminalScrollbackChanged(5000)
    registerTerminalOutputPersistSource(() => [id])
  })

  afterEach(() => {
    clearTerminalOutput(id, { persist: false })
    vi.unstubAllGlobals()
  })

  it('persists the rendered screen on exit and keeps it until new output arrives', () => {
    const capture = vi.fn(() => ({
      data: 'SCREENtail',
      cols: 100,
      rows: 30,
      screenChars: 6,
    }))
    const unregister = registerTerminalPersistCapture(id, capture)
    try {
      publishTerminalOutput(id, Array.from(encoder.encode('\x1b[1Araw-frame')), 42)

      persistTerminalOutputNow()
      expect(capture).not.toHaveBeenCalled()
      expect(loadTerminalOutputSnapshot()?.terminals[id].scrollback).toBe('\x1b[1Araw-frame')

      persistTerminalOutputNow({ renderScreens: true })
      const saved = loadTerminalOutputSnapshot()?.terminals[id]
      expect(saved?.scrollback).toBe('SCREENtail')
      expect(saved?.screen).toEqual({ cols: 100, rows: 30, chars: 6 })
      expect(saved?.seq).toBe(42)

      // 关闭流程里晚到的定时持久化：没有新输出时沿用渲染结果，不换回原始字节。
      persistTerminalOutputNow()
      expect(loadTerminalOutputSnapshot()?.terminals[id].scrollback).toBe('SCREENtail')
      expect(capture).toHaveBeenCalledTimes(1)

      publishTerminalOutput(id, Array.from(encoder.encode('more')), 46)
      persistTerminalOutputNow()
      const after = loadTerminalOutputSnapshot()?.terminals[id]
      expect(after?.scrollback).toBe('\x1b[1Araw-framemore')
      expect(after?.screen).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it('falls back to raw output while the view cannot capture', () => {
    const unregister = registerTerminalPersistCapture(id, () => null)
    try {
      publishTerminalOutput(id, Array.from(encoder.encode('plain')), 5)
      persistTerminalOutputNow({ renderScreens: true })
      const saved = loadTerminalOutputSnapshot()?.terminals[id]
      expect(saved?.scrollback).toBe('plain')
      expect(saved?.screen).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it('restores the screen prefix on its own grid and the tail as raw output', () => {
    localStorage.setItem(
      TERMINAL_SESSION_OUTPUT_KEY,
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        terminals: {
          [id]: {
            scrollback: 'SCREENtail',
            history: [],
            updatedAt: 1,
            seq: 9,
            screen: { cols: 100, rows: 30, chars: 6 },
          },
        },
      })
    )
    hydrateTerminalOutputForTabs([id])
    expect(terminalResumeSeqs.get(id)).toBe(9)

    const events: Array<string | TerminalViewSnapshot> = []
    const unsubscribe = subscribeTerminalOutput(
      id,
      data => events.push(decoder.decode(data)),
      snapshot => events.push(snapshot)
    )
    unsubscribe()
    expect(events).toEqual([{ data: 'SCREEN', cols: 100, rows: 30 }, 'tail'])

    // 没有视图时再次持久化，ring 开头仍是完整的屏幕段，网格随之保留。
    persistTerminalOutputNow()
    expect(loadTerminalOutputSnapshot()?.terminals[id].screen).toEqual({
      cols: 100,
      rows: 30,
      chars: 6,
    })
  })
})
