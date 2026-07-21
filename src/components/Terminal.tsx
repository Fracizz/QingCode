import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  hasTerminalScrollback,
  subscribeTerminalOutput,
  useTerminalStore,
} from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import {
  FONT_SETTINGS_EVENT,
  getResolvedTerminalFont,
  getResolvedTerminalFontSize,
} from '../lib/fontSettings'
import { THEME_SETTINGS_EVENT, getResolvedTheme } from '../lib/themeSettings'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import {
  TERMINAL_SCROLLBACK_SETTINGS_EVENT,
  getTerminalScrollback,
} from '../lib/terminalScrollbackSettings'
import {
  TERMINAL_CURSOR_SETTINGS_EVENT,
  getTerminalCursorBlinking,
} from '../lib/terminalCursorSettings'
import {
  TERMINAL_CLEAR_EVENT,
  TERMINAL_SEARCH_EVENT,
  type TerminalViewBridgeDetail,
} from '../lib/terminalViewBridge'
import {
  markTerminalCommandFinished,
  markTerminalCommandStarted,
} from '../lib/terminalCommandActivity'
import { MATERIAL_FOREST as M } from '../lib/materialForestTheme'
import { shouldKeepShellAfterExit } from '../lib/terminalShellLifecycle'
import {
  isPanelResizing,
  PANEL_RESIZE_BEGIN_EVENT,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_SETTLE_EVENT,
} from '../lib/panelResize'
import { TerminalOscParser } from '../utils/terminalOsc'
import { shouldApplyOscTabTitle } from '../utils/terminalName'
import { translate } from '../lib/i18n'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import TerminalSearchBar from './TerminalSearchBar'
import '@xterm/xterm/css/xterm.css'

/** Highlight + count require decorations; colors must be #RRGGBB. */
const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#613214',
  activeMatchBackground: '#515c6a',
  matchOverviewRuler: '#d18616',
  activeMatchColorOverviewRuler: '#f3a600',
}

function terminalSearchOptions(incremental = false): ISearchOptions {
  return {
    incremental,
    decorations: TERMINAL_SEARCH_DECORATIONS,
  }
}

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
  background: M.contrast,
  foreground: M.foreground,
  cursor: M.accent,
  cursorAccent: M.contrast,
  selectionBackground: M.selectionBg,
  black: M.contrast,
  red: M.syntax.red,
  green: M.syntax.green,
  yellow: M.syntax.yellow,
  blue: M.syntax.blue,
  magenta: M.syntax.purple,
  cyan: M.syntax.cyan,
  white: M.syntax.white,
  brightBlack: M.syntax.comments,
  brightRed: M.syntax.red,
  brightGreen: M.syntax.green,
  brightYellow: M.syntax.yellow,
  brightBlue: M.syntax.blue,
  brightMagenta: M.syntax.purple,
  brightCyan: M.syntax.cyan,
  brightWhite: M.syntax.white,
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
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const fitRafRef = useRef(0)
  const pendingFitFlagsRef = useRef({ refresh: false, focusAfter: false })
  const pendingPtySizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastFitSizeRef = useRef({ w: 0, h: 0 })
  const isActiveRef = useRef(isActive)
  const previousStatusRef = useRef<string | undefined>(undefined)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1)
  const [searchMatchTotal, setSearchMatchTotal] = useState(0)
  isActiveRef.current = isActive
  const writeToTerminal = useTerminalStore(s => s.writeToTerminal)
  const resizeTerminal = useTerminalStore(s => s.resizeTerminal)
  const spawnPendingTerminal = useTerminalStore(s => s.spawnPendingTerminal)
  const terminal = useTerminalStore(s => s.terminals.find(tab => tab.id === terminalId))
  const ptySpawnPending = terminal?.ptySpawnPending === true

  const isTerminalWritable = () =>
    useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)?.status !== 'exited'

  const copySelection = async () => {
    const term = xtermRef.current
    if (!term?.hasSelection()) return
    const selection = term.getSelection()
    if (!selection) return
    try {
      await navigator.clipboard.writeText(selection)
    } catch (error) {
      console.error('Terminal copy failed:', error)
    }
  }

  const pasteFromClipboard = async () => {
    const term = xtermRef.current
    if (!term || !isTerminalWritable()) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) term.paste(text)
    } catch (error) {
      console.error('Terminal paste failed:', error)
    }
  }

  const selectAll = () => {
    xtermRef.current?.selectAll()
  }

  const clearBuffer = () => {
    const term = xtermRef.current
    if (!term) return
    term.clear()
    term.scrollToBottom()
  }

  const resetSearchMatch = () => {
    setSearchMatchIndex(-1)
    setSearchMatchTotal(0)
  }

  const openSearch = () => {
    setSearchOpen(true)
    resetSearchMatch()
  }

  const closeSearch = () => {
    searchAddonRef.current?.clearDecorations()
    setSearchOpen(false)
    resetSearchMatch()
    if (isActiveRef.current) xtermRef.current?.focus()
  }

  const runFind = (direction: 'next' | 'previous') => {
    const addon = searchAddonRef.current
    const query = searchQuery
    if (!addon || !query.trim()) {
      resetSearchMatch()
      return
    }
    const opts = terminalSearchOptions(false)
    if (direction === 'next') addon.findNext(query, opts)
    else addon.findPrevious(query, opts)
  }

  const contextMenuItems = (): ContextMenuItem[] => [
    {
      label: translate('复制'),
      shortcut: 'Ctrl+C',
      disabled: !xtermRef.current?.hasSelection(),
      action: () => {
        void copySelection()
      },
    },
    {
      label: translate('粘贴'),
      shortcut: 'Ctrl+V',
      disabled: !isTerminalWritable(),
      action: () => {
        void pasteFromClipboard()
      },
    },
    {
      label: translate('全选'),
      separatorBefore: true,
      action: selectAll,
    },
    {
      label: translate('在终端中查找'),
      shortcut: 'Ctrl+F',
      separatorBefore: true,
      action: openSearch,
    },
    {
      label: translate('清空终端'),
      shortcut: 'Ctrl+Shift+K',
      action: clearBuffer,
    },
  ]

  const fitNow = (refresh = false, focusAfter = false) => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
    const term = xtermRef.current
    if (!term) return
    const w = container.clientWidth
    const h = container.clientHeight
    if (!refresh && w === lastFitSizeRef.current.w && h === lastFitSizeRef.current.h) return
    lastFitSizeRef.current = { w, h }
    try {
      fitAddonRef.current?.fit()
      const pending = useTerminalStore
        .getState()
        .terminals.find(tab => tab.id === terminalId)?.ptySpawnPending
      if (pending) {
        void spawnPendingTerminal(terminalId, term.cols, term.rows)
      }
      if (refresh) {
        term.refresh(0, term.rows - 1)
        term.scrollToBottom()
      }
      if (focusAfter && isActiveRef.current) term.focus()
    } catch {}
  }

  const scheduleFit = (refresh = false, focusAfter = false) => {
    pendingFitFlagsRef.current = {
      refresh: pendingFitFlagsRef.current.refresh || refresh,
      focusAfter: pendingFitFlagsRef.current.focusAfter || focusAfter,
    }
    // Coalesce to one fit per frame and retain requests made during sash drag.
    if (fitRafRef.current !== 0 || isPanelResizing()) return
    fitRafRef.current = window.requestAnimationFrame(() => {
      fitRafRef.current = 0
      if (isPanelResizing()) return
      const flags = pendingFitFlagsRef.current
      pendingFitFlagsRef.current = { refresh: false, focusAfter: false }
      fitNow(flags.refresh, flags.focusAfter)
    })
  }

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: getTerminalCursorBlinking(),
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      fontSize: getResolvedTerminalFontSize(),
      fontFamily: getResolvedTerminalFont(),
      lineHeight: 1.0,
      letterSpacing: 0,
      scrollback: getTerminalScrollback(),
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
    const searchAddon = new SearchAddon()
    const linkAddon = new WebLinksAddon((_event, uri) => {
      // Ctrl/Cmd + 点击链接：用系统默认浏览器打开（Tauri opener 插件）。
      void openUrl(uri).catch(e => {
        useProjectStore.getState().pushToast('error', `打开链接失败: ${String(e)}`)
      })
    })
    const clipboardAddon = new ClipboardAddon()
    const unicode11 = new Unicode11Addon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(linkAddon)
    term.loadAddon(clipboardAddon)
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    term.open(containerRef.current)
    searchAddonRef.current = searchAddon
    const searchResultsSub = searchAddon.onDidChangeResults(event => {
      setSearchMatchIndex(event.resultIndex)
      setSearchMatchTotal(event.resultCount)
    })

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
    const hadRestoredScrollback = hasTerminalScrollback(terminalId)
    // Restored scrollback is written via subscribeTerminalOutput; only show a
    // status line when there is nothing to replay (or after restore note).
    if (tab?.status === 'exited' && !hadRestoredScrollback) {
      const detail =
        tab.exitCode === null
          ? translate('进程未启动')
          : translate('进程已退出，退出码 {code}', { code: String(tab.exitCode) })
      term.writeln(`\x1b[90m[${detail}${translate('，可从终端标签重启')}]\x1b[0m`)
    }

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && !event.altKey && !event.shiftKey && key === 'f') {
        event.preventDefault()
        openSearch()
        return false
      }
      if (mod && event.shiftKey && !event.altKey && key === 'k') {
        event.preventDefault()
        clearBuffer()
        return false
      }
      if (mod && !event.altKey && !event.shiftKey && key === 'c') {
        if (term.hasSelection()) {
          void copySelection()
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

    const updateScrollback = () => {
      term.options.scrollback = getTerminalScrollback()
    }
    window.addEventListener(TERMINAL_SCROLLBACK_SETTINGS_EVENT, updateScrollback)
    updateScrollback()

    const updateCursor = () => {
      term.options.cursorBlink = getTerminalCursorBlinking()
    }
    window.addEventListener(TERMINAL_CURSOR_SETTINGS_EVENT, updateCursor)
    updateCursor()

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
      // Defer PTY size until sash mouseup — shell full redraws every frame = flicker.
      if (isPanelResizing()) {
        pendingPtySizeRef.current = { cols, rows }
        return
      }
      pendingPtySizeRef.current = null
      void resizeTerminal(terminalId, cols, rows)
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
        const cleaned = oscParser.feed(data, {
          onTitle: title => {
            const current = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
            // Follow meaningful OSC titles; keep「终端 N」unless cwd/app renames it.
            // Generic ConPTY/PowerShell titles are ignored (see shouldApplyOscTabTitle).
            if (shouldApplyOscTabTitle(current, title)) {
              useTerminalStore.getState().renameTerminal(terminalId, title)
            }
          },
          onCommandStart: () => markTerminalCommandStarted(terminalId),
          onCommandEnd: () => markTerminalCommandFinished(terminalId),
        })
        term.write(cleaned)
      })
      const restored = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
      if (restored?.status === 'exited' && hadRestoredScrollback) {
        const note = restored.awaitingRestoreSpawn
          ? translate('会话输出已恢复；进程将按原配置重新启动')
          : translate('会话输出已恢复；可从终端标签重启进程')
        term.writeln(`\x1b[90m[${note}]\x1b[0m`)
      }
    }, 0)

    const ro = new ResizeObserver(() => {
      if (!isActiveRef.current) return
      if (isPanelResizing()) return
      scheduleFit()
    })
    if (containerRef.current) ro.observe(containerRef.current)

    const onPanelResizeBegin = () => {
      if (isActiveRef.current) term.options.cursorBlink = false
    }
    const onPanelResizeSettle = () => {
      if (!isActiveRef.current) return
      if (fitRafRef.current !== 0) {
        window.cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = 0
      }
      const flags = pendingFitFlagsRef.current
      pendingFitFlagsRef.current = { refresh: false, focusAfter: false }
      lastFitSizeRef.current = { w: 0, h: 0 }
      // The final flex geometry is active, while the old WebGL surface is still clipped.
      fitNow(flags.refresh, flags.focusAfter)
    }
    const onPanelResizeEnd = () => {
      term.options.cursorBlink = getTerminalCursorBlinking()
      if (!isActiveRef.current) return
      const pendingPtySize = pendingPtySizeRef.current
      pendingPtySizeRef.current = null
      if (pendingPtySize) {
        void resizeTerminal(terminalId, pendingPtySize.cols, pendingPtySize.rows)
      }
    }
    window.addEventListener(PANEL_RESIZE_BEGIN_EVENT, onPanelResizeBegin)
    window.addEventListener(PANEL_RESIZE_SETTLE_EVENT, onPanelResizeSettle)
    window.addEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd)

    return () => {
      window.clearTimeout(subscribeTimer)
      for (const id of fitTimers) window.clearTimeout(id)
      if (fitRafRef.current !== 0) {
        window.cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = 0
      }
      unsubscribeOutput?.()
      window.removeEventListener(FONT_SETTINGS_EVENT, updateFont)
      window.removeEventListener(TERMINAL_SCROLLBACK_SETTINGS_EVENT, updateScrollback)
      window.removeEventListener(TERMINAL_CURSOR_SETTINGS_EVENT, updateCursor)
      window.removeEventListener(THEME_SETTINGS_EVENT, updateTheme)
      window.removeEventListener(PANEL_RESIZE_BEGIN_EVENT, onPanelResizeBegin)
      window.removeEventListener(PANEL_RESIZE_SETTLE_EVENT, onPanelResizeSettle)
      window.removeEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd)
      ro.disconnect()
      searchResultsSub.dispose()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('mousedown', onMouseDown)
      term.dispose()
      container.replaceChildren()
      xtermRef.current = null
      searchAddonRef.current = null
    }
  }, [terminalId, writeToTerminal, resizeTerminal, spawnPendingTerminal])

  useEffect(() => {
    if (!isActive) return
    // Size-only: fit without full refresh/scrollToBottom (avoids end-of-drag flash).
    scheduleFit(false, false)
  }, [layoutKey])

  useEffect(() => {
    if (!isActive) return
    scheduleFit(true, true)
  }, [isActive])

  // Restart / deferred create: fit again as soon as a PTY is requested.
  useEffect(() => {
    if (!ptySpawnPending) return
    scheduleFit(true, isActiveRef.current)
  }, [ptySpawnPending, terminalId])

  useEffect(() => {
    const matches = (detail?: TerminalViewBridgeDetail) => {
      if (detail?.terminalId && detail.terminalId !== terminalId) return false
      return isActiveRef.current || detail?.terminalId === terminalId
    }
    const onClear = (event: Event) => {
      const detail = (event as CustomEvent<TerminalViewBridgeDetail>).detail
      if (!matches(detail)) return
      clearBuffer()
    }
    const onSearch = (event: Event) => {
      const detail = (event as CustomEvent<TerminalViewBridgeDetail>).detail
      if (!matches(detail)) return
      openSearch()
    }
    window.addEventListener(TERMINAL_CLEAR_EVENT, onClear)
    window.addEventListener(TERMINAL_SEARCH_EVENT, onSearch)
    return () => {
      window.removeEventListener(TERMINAL_CLEAR_EVENT, onClear)
      window.removeEventListener(TERMINAL_SEARCH_EVENT, onSearch)
    }
  }, [terminalId])

  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) {
      resetSearchMatch()
      searchAddonRef.current?.clearDecorations()
      return
    }
    searchAddonRef.current?.findNext(searchQuery, terminalSearchOptions(true))
  }, [searchQuery, searchOpen])

  useEffect(() => {
    const term = xtermRef.current
    if (!term || !terminal) return
    const previous = previousStatusRef.current
    if (terminal.status === 'starting' && previous === 'exited') {
      if (terminal.restorePreservedOutput) {
        term.writeln(`\x1b[90m\r\n── ${translate('正在重启终端…')} ──\x1b[0m`)
      } else {
        term.reset()
        term.writeln(`\x1b[90m${translate('正在重启终端…')}\x1b[0m`)
      }
    } else if (terminal.status === 'exited' && previous !== 'exited') {
      if (terminal.exitCode === null) {
        term.writeln(`\r\n\x1b[90m[${translate('进程未启动')}${translate('，可从终端标签重启')}]\x1b[0m`)
      } else if (!shouldKeepShellAfterExit(terminal)) {
        // Run-config / one-shot tasks: PTY is gone — explain why typing is disabled.
        term.writeln(
          `\r\n\x1b[90m── ${translate('运行配置任务已结束（退出码 {code}）', {
            code: String(terminal.exitCode),
          })} ──\x1b[0m`,
        )
        term.writeln(
          `\x1b[90m${translate(
            '由运行配置拉起，结束后不能继续输入。点标签「重启」再跑，或新开普通终端。',
          )}\x1b[0m`,
        )
      } else {
        const detail = translate('进程已退出，退出码 {code}', { code: String(terminal.exitCode) })
        term.writeln(`\r\n\x1b[90m[${detail}${translate('，可从终端标签重启')}]\x1b[0m`)
      }
    }
    previousStatusRef.current = terminal.status
  }, [terminal])

  return (
    <div
      className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden box-border"
      onMouseDown={() => {
        if (isActive) xtermRef.current?.focus()
      }}
      onContextMenu={(event: ReactMouseEvent) => {
        if (!shouldShowAppContextMenu(event)) return
        setContextMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden px-2.5 py-2">
        {searchOpen ? (
          <TerminalSearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onFindNext={() => runFind('next')}
            onFindPrevious={() => runFind('previous')}
            onClose={closeSearch}
            matchIndex={searchMatchIndex}
            matchTotal={searchMatchTotal}
          />
        ) : null}
        <div ref={containerRef} className="h-full w-full min-h-0 min-w-0" />
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
