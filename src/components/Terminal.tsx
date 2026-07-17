import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { openUrl } from '@tauri-apps/plugin-opener'
import { subscribeTerminalOutput, useTerminalStore } from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import {
  FONT_SETTINGS_EVENT,
  getResolvedTerminalFont,
  getResolvedTerminalFontSize,
} from '../lib/fontSettings'
import { THEME_SETTINGS_EVENT, getResolvedTheme } from '../lib/themeSettings'
import { TerminalOscParser } from '../utils/terminalOsc'
import '@xterm/xterm/css/xterm.css'

// Backgrounds match App.css --color-bg-deep so the caret/outline stays visible.
const DARK_THEME = {
  background: '#181818',
  foreground: '#d4d4d4',
  cursor: '#aeafad',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#f48771',
  green: '#89d185',
  yellow: '#e2c08d',
  blue: '#75aaf0',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d4d4d4',
  brightBlack: '#6b6b6b',
  brightRed: '#f48771',
  brightGreen: '#89d185',
  brightYellow: '#e2c08d',
  brightBlue: '#75aaf0',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

const LIGHT_THEME = {
  background: '#e6e6e6',
  foreground: '#1f1f1f',
  cursor: '#1a1a1a',
  cursorAccent: '#e6e6e6',
  selectionBackground: '#b9d6f5',
  black: '#000000',
  red: '#c43b32',
  green: '#107c10',
  yellow: '#9a6a00',
  blue: '#005fb8',
  magenta: '#9b1b9b',
  cyan: '#0b7a85',
  white: '#1a1a1a',
  brightBlack: '#5a5a5a',
  brightRed: '#a3261e',
  brightGreen: '#0b6a0b',
  brightYellow: '#7a5400',
  brightBlue: '#004488',
  brightMagenta: '#7a1488',
  brightCyan: '#055a63',
  brightWhite: '#000000',
}

const FOREST_THEME = {
  background: '#232a2e',
  foreground: '#d3c6aa',
  cursor: '#d3c6aa',
  cursorAccent: '#232a2e',
  selectionBackground: '#543a48',
  black: '#232a2e',
  red: '#e67e80',
  green: '#a7c080',
  yellow: '#dbbc7f',
  blue: '#7fbbb3',
  magenta: '#d699b6',
  cyan: '#83c092',
  white: '#d3c6aa',
  brightBlack: '#7a8478',
  brightRed: '#e67e80',
  brightGreen: '#a7c080',
  brightYellow: '#dbbc7f',
  brightBlue: '#7fbbb3',
  brightMagenta: '#d699b6',
  brightCyan: '#83c092',
  brightWhite: '#fdf6e3',
}

function terminalTheme() {
  const resolved = getResolvedTheme()
  if (resolved === 'forest') return FOREST_THEME
  if (resolved === 'dark') return DARK_THEME
  return LIGHT_THEME
}

/** ConPTY heuristics for Windows hosts (portable-pty / OpenCode TUI). */
function windowsPtyOptions(): { backend: 'conpty'; buildNumber: number } | undefined {
  if (typeof navigator === 'undefined') return undefined
  const ua = navigator.userAgent
  if (!/Windows/i.test(ua)) return undefined
  // Win10 2004+ / Win11 ConPTY builds; high enough to enable modern wrap/reflow.
  return { backend: 'conpty', buildNumber: 22621 }
}

interface TerminalViewProps {
  terminalId: string
  layoutKey?: string
  isActive?: boolean
}

export default function TerminalView({ terminalId, layoutKey, isActive = false }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isActiveRef = useRef(isActive)
  const previousStatusRef = useRef<string | undefined>(undefined)
  isActiveRef.current = isActive
  const writeToTerminal = useTerminalStore(s => s.writeToTerminal)
  const resizeTerminal = useTerminalStore(s => s.resizeTerminal)
  const terminal = useTerminalStore(s => s.terminals.find(tab => tab.id === terminalId))

  const scheduleFit = (refresh = false, focusAfter = false) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const container = containerRef.current
        if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
        const term = xtermRef.current
        if (!term) return
        try {
          fitAddonRef.current?.fit()
          if (refresh) term.refresh(0, term.rows - 1)
          if (focusAfter && isActiveRef.current) term.focus()
        } catch {}
      })
    })
  }

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      fontSize: getResolvedTerminalFontSize(),
      fontFamily: getResolvedTerminalFont(),
      lineHeight: 1.0,
      letterSpacing: 0,
      // WebGL/canvas: draw box/block glyphs ourselves so WebView2 font metrics
      // cannot stretch OpenCode ASCII banners.
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      theme: terminalTheme(),
      cols: 80,
      rows: 20,
      allowProposedApi: true,
      windowsPty: windowsPtyOptions(),
    })

    const fitAddon = new FitAddon()
    const linkAddon = new WebLinksAddon((_event, uri) => {
      // Ctrl/Cmd + 点击链接：用系统默认浏览器打开（Tauri opener 插件）。
      void openUrl(uri).catch(e => {
        useProjectStore.getState().pushToast('error', `打开链接失败: ${String(e)}`)
      })
    })
    const clipboardAddon = new ClipboardAddon()
    const unicode11 = new Unicode11Addon()
    term.loadAddon(fitAddon)
    term.loadAddon(linkAddon)
    term.loadAddon(clipboardAddon)
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    term.open(containerRef.current)

    // Prefer WebGL so customGlyphs apply; fall back silently to canvas.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        try {
          webgl.dispose()
        } catch {}
      })
      term.loadAddon(webgl)
    } catch {
      // Canvas renderer remains active.
    }

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    const tab = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
    previousStatusRef.current = tab?.status
    if (tab?.status === 'exited') {
      const detail =
        tab.exitCode === null ? '进程未启动' : `进程已退出，退出码 ${tab.exitCode}`
      term.writeln(`\x1b[90m[${detail}，可从终端标签重启]\x1b[0m`)
    }

    const isTerminalWritable = () =>
      useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)?.status !== 'exited'

    const pasteFromClipboard = async () => {
      if (!isTerminalWritable()) return
      try {
        const text = await navigator.clipboard.readText()
        if (text) term.paste(text)
      } catch (error) {
        console.error('Terminal paste failed:', error)
      }
    }

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && !event.altKey && !event.shiftKey && key === 'c') {
        if (term.hasSelection()) {
          const selection = term.getSelection()
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(error => {
              console.error('Terminal copy failed:', error)
            })
          }
          return false
        }
        if (event.ctrlKey) {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat && isTerminalWritable()) {
            void writeToTerminal(terminalId, '\x03')
          }
          return false
        }
      }
      if (mod && key === 'v') {
        event.preventDefault()
        void pasteFromClipboard()
        return false
      }
      if (event.shiftKey && event.key === 'Insert') {
        event.preventDefault()
        void pasteFromClipboard()
        return false
      }
      return true
    })

    const onPaste = (event: ClipboardEvent) => {
      if (!isTerminalWritable()) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text) return
      event.preventDefault()
      event.stopPropagation()
      void pasteFromClipboard()
    }

    const onMouseDown = () => {
      term.focus()
    }

    const container = containerRef.current
    container.addEventListener('paste', onPaste, true)
    container.addEventListener('mousedown', onMouseDown)

    const updateFont = () => {
      term.options.fontFamily = getResolvedTerminalFont()
      term.options.fontSize = getResolvedTerminalFontSize()
      scheduleFit(true, isActiveRef.current)
    }
    window.addEventListener(FONT_SETTINGS_EVENT, updateFont)
    updateFont()

    const updateTheme = () => {
      term.options.theme = terminalTheme()
    }
    window.addEventListener(THEME_SETTINGS_EVENT, updateTheme)

    scheduleFit(false, isActiveRef.current)

    // Release builds show the window after splash; delayed refits catch final size
    // and Cascadia/Consolas loading so OpenCode gets correct cols before painting.
    const fitTimers = [50, 150, 400].map(ms =>
      window.setTimeout(() => scheduleFit(true, false), ms),
    )
    void document.fonts?.ready?.then(() => {
      term.options.fontFamily = getResolvedTerminalFont()
      scheduleFit(true, false)
    })

    term.onResize(({ cols, rows }) => {
      resizeTerminal(terminalId, cols, rows)
    })
    term.onData(data => {
      const status = useTerminalStore
        .getState()
        .terminals.find(tab => tab.id === terminalId)?.status
      if (status !== 'exited') writeToTerminal(terminalId, data)
    })
    // 程序通过 OSC 设置窗口标题时自动更新标签名（如 opencode）；运行任务终端不跟随。
    let unsubscribeOutput: (() => void) | undefined
    const oscParser = new TerminalOscParser()
    const subscribeTimer = window.setTimeout(() => {
      unsubscribeOutput = subscribeTerminalOutput(terminalId, data => {
        const cleaned = oscParser.feed(data, title => {
          const tab = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
          if (tab?.allowTitleRename !== false && title) {
            useTerminalStore.getState().renameTerminal(terminalId, title)
          }
        })
        term.write(cleaned)
      })
    }, 0)

    const ro = new ResizeObserver(() => {
      if (!isActiveRef.current) return
      scheduleFit()
    })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      window.clearTimeout(subscribeTimer)
      for (const id of fitTimers) window.clearTimeout(id)
      unsubscribeOutput?.()
      window.removeEventListener(FONT_SETTINGS_EVENT, updateFont)
      window.removeEventListener(THEME_SETTINGS_EVENT, updateTheme)
      ro.disconnect()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('mousedown', onMouseDown)
      term.dispose()
      container.replaceChildren()
      xtermRef.current = null
    }
  }, [terminalId, writeToTerminal, resizeTerminal])

  useEffect(() => {
    if (!isActive) return
    scheduleFit(true, true)
  }, [isActive, layoutKey])

  useEffect(() => {
    const term = xtermRef.current
    if (!term || !terminal) return
    const previous = previousStatusRef.current
    if (terminal.status === 'starting' && previous === 'exited') {
      term.reset()
      term.writeln('\x1b[90m正在重启终端…\x1b[0m')
    } else if (terminal.status === 'exited' && previous !== 'exited') {
      const detail =
        terminal.exitCode === null ? '进程未启动' : `进程已退出，退出码 ${terminal.exitCode}`
      term.writeln(`\r\n\x1b[90m[${detail}，可从终端标签重启]\x1b[0m`)
    }
    previousStatusRef.current = terminal.status
  }, [terminal])

  return (
    <div
      className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden box-border"
      onMouseDown={() => {
        if (isActive) xtermRef.current?.focus()
      }}
    >
      {terminal?.launchCommand.trim() ? (
        <div
          className="shrink-0 border-b border-border bg-bg-deep px-2.5 py-1 text-fg-dim truncate"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--terminal-font-size)' }}
          title={terminal.launchCommand.trim()}
        >
          {'> '}
          {terminal.launchCommand.trim()}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-2.5 py-2">
        <div ref={containerRef} className="h-full w-full min-h-0 min-w-0" />
      </div>
    </div>
  )
}
