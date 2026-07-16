import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useTerminalStore } from '../store/terminalStore'
import { isTauri } from '../lib/tauri'
import { FONT_SETTINGS_EVENT } from '../lib/fontSettings'
import { THEME_SETTINGS_EVENT, getResolvedTheme } from '../lib/themeSettings'
import '@xterm/xterm/css/xterm.css'

const DARK_THEME = {
  background: '#181818',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
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
  background: '#f0f0f0',
  foreground: '#1f1f1f',
  cursor: '#1f1f1f',
  cursorAccent: '#f0f0f0',
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

function terminalTheme() {
  return getResolvedTheme() === 'dark' ? DARK_THEME : LIGHT_THEME
}

export default function TerminalView({ terminalId }: { terminalId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const unlistenRef = useRef<UnlistenFn | null>(null)
  const previousStatusRef = useRef<string | undefined>(undefined)
  const writeToTerminal = useTerminalStore(s => s.writeToTerminal)
  const resizeTerminal = useTerminalStore(s => s.resizeTerminal)
  const terminal = useTerminalStore(s => s.terminals.find(tab => tab.id === terminalId))

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      theme: terminalTheme(),
      cols: 80,
      rows: 20,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const linkAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(linkAddon)
    term.open(containerRef.current)

    const updateFont = () => {
      const styles = getComputedStyle(document.documentElement)
      term.options.fontFamily = styles.getPropertyValue('--font-mono').trim()
      term.options.fontSize = Number.parseInt(styles.getPropertyValue('--mono-font-size'), 10) || 13
      try {
        fitAddon.fit()
      } catch {}
    }
    window.addEventListener(FONT_SETTINGS_EVENT, updateFont)
    updateFont()

    const updateTheme = () => {
      term.options.theme = terminalTheme()
    }
    window.addEventListener(THEME_SETTINGS_EVENT, updateTheme)

    const doFit = () => {
      try {
        fitAddon.fit()
      } catch {}
    }
    const t = setTimeout(doFit, 60)

    term.onResize(({ cols, rows }) => {
      resizeTerminal(terminalId, cols, rows)
    })
    term.onData(data => {
      const status = useTerminalStore
        .getState()
        .terminals.find(tab => tab.id === terminalId)?.status
      if (status !== 'exited') writeToTerminal(terminalId, data)
    })

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    const ro = new ResizeObserver(doFit)
    if (containerRef.current) ro.observe(containerRef.current)

    let cancelled = false
    if (isTauri()) {
      listen<{ id: string; data: string }>('terminal-data', event => {
        if (event.payload.id === terminalId) {
          term.write(event.payload.data)
        }
      }).then(fn => {
        if (cancelled) fn()
        else unlistenRef.current = fn
      })
    }

    return () => {
      cancelled = true
      window.removeEventListener(FONT_SETTINGS_EVENT, updateFont)
      window.removeEventListener(THEME_SETTINGS_EVENT, updateTheme)
      clearTimeout(t)
      ro.disconnect()
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
      term.dispose()
      xtermRef.current = null
    }
  }, [terminalId, writeToTerminal, resizeTerminal])

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

  return <div ref={containerRef} className="h-full w-full" />
}
