import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  type PanelResizeSettleDetail,
} from '../lib/panelResize'
import {
  getTerminalPtyResizeDelay,
  isValidTerminalGridSize,
  terminalGridSizeChanged,
  type TerminalGridSize,
} from '../lib/terminalResizePolicy'
import { waitForTerminalRender } from '../lib/terminalRenderBarrier'
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
  const ptyResizeTimerRef = useRef<number | null>(null)
  const pendingFitFlagsRef = useRef({ refresh: false, focusAfter: false })
  const pendingPtySizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastFitSizeRef = useRef({ w: 0, h: 0 })
  const isActiveRef = useRef(isActive)
  const previousStatusRef = useRef<string | undefined>(undefined)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1)
  const [searchMatchTotal, setSearchMatchTotal] = useState(0)
  const writeToTerminal = useTerminalStore(s => s.writeToTerminal)
  const resizeTerminal = useTerminalStore(s => s.resizeTerminal)
  const spawnPendingTerminal = useTerminalStore(s => s.spawnPendingTerminal)
  const terminal = useTerminalStore(s => s.terminals.find(tab => tab.id === terminalId))
  const ptySpawnPending = terminal?.ptySpawnPending === true

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  const isTerminalWritable = useCallback(
    () => useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)?.status !== 'exited',
    [terminalId],
  )

  const copySelection = useCallback(async () => {
    const term = xtermRef.current
    if (!term?.hasSelection()) return
    const selection = term.getSelection()
    if (!selection) return
    try {
      await navigator.clipboard.writeText(selection)
    } catch (error) {
      console.error('Terminal copy failed:', error)
    }
  }, [])

  const pasteFromClipboard = useCallback(async () => {
    const term = xtermRef.current
    if (!term || !isTerminalWritable()) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) term.paste(text)
    } catch (error) {
      console.error('Terminal paste failed:', error)
    }
  }, [isTerminalWritable])

  const selectAll = useCallback(() => {
    xtermRef.current?.selectAll()
  }, [])

  const clearBuffer = useCallback(() => {
    const term = xtermRef.current
    if (!term) return
    term.clear()
    term.scrollToBottom()
  }, [])

  const resetSearchMatch = useCallback(() => {
    setSearchMatchIndex(-1)
    setSearchMatchTotal(0)
  }, [])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    resetSearchMatch()
  }, [resetSearchMatch])

  const closeSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations()
    setSearchOpen(false)
    resetSearchMatch()
    if (isActiveRef.current) xtermRef.current?.focus()
  }, [resetSearchMatch])

  const runFind = (direction: 'next' | 'previous') => {
    const addon = searchAddonRef.current
    const query = searchQuery
    if (!addon || !query.trim()) {
      queueMicrotask(resetSearchMatch)
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

  const clearPtyResizeTimer = useCallback(() => {
    if (ptyResizeTimerRef.current === null) return
    window.clearTimeout(ptyResizeTimerRef.current)
    ptyResizeTimerRef.current = null
  }, [])

  const commitGridSize = useCallback((next: TerminalGridSize) => {
    const term = xtermRef.current
    if (!term || !terminalGridSizeChanged({ cols: term.cols, rows: term.rows }, next)) return false
    // 直接 resize 便于准确判断是否需要等待下方的 onRender 屏障。
    term.resize(next.cols, next.rows)
    return true
  }, [])

  const readProposedGridSize = useCallback((): TerminalGridSize | undefined => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return undefined
    const next = fitAddonRef.current?.proposeDimensions()
    return isValidTerminalGridSize(next) ? next : undefined
  }, [])

  const resizeGridFromContainer = useCallback(() => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return false
    lastFitSizeRef.current = { w: container.clientWidth, h: container.clientHeight }
    const next = readProposedGridSize()
    return next ? commitGridSize(next) : false
  }, [commitGridSize, readProposedGridSize])

  const fitSettledPanelGrid = useCallback(() => {
    return resizeGridFromContainer()
  }, [resizeGridFromContainer])

  const flushPendingPtyResize = useCallback(() => {
    clearPtyResizeTimer()
    const pending = pendingPtySizeRef.current
    pendingPtySizeRef.current = null
    if (pending) void resizeTerminal(terminalId, pending.cols, pending.rows)
  }, [clearPtyResizeTimer, resizeTerminal, terminalId])

  const schedulePtyResize = useCallback((next: TerminalGridSize) => {
    const term = xtermRef.current
    pendingPtySizeRef.current = next
    clearPtyResizeTimer()
    const delay = getTerminalPtyResizeDelay(term?.buffer.active.type ?? 'normal')
    ptyResizeTimerRef.current = window.setTimeout(() => {
      ptyResizeTimerRef.current = null
      flushPendingPtyResize()
    }, delay)
  }, [clearPtyResizeTimer, flushPendingPtyResize])

  const fitNow = useCallback((refresh = false, focusAfter = false) => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
    const term = xtermRef.current
    if (!term) return
    const w = container.clientWidth
    const h = container.clientHeight
    if (!refresh && w === lastFitSizeRef.current.w && h === lastFitSizeRef.current.h) return
    lastFitSizeRef.current = { w, h }
    try {
      const next = readProposedGridSize()
      if (next) commitGridSize(next)
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
  }, [commitGridSize, readProposedGridSize, spawnPendingTerminal, terminalId])

  const scheduleFit = useCallback((refresh = false, focusAfter = false) => {
    pendingFitFlagsRef.current = {
      refresh: pendingFitFlagsRef.current.refresh || refresh,
      focusAfter: pendingFitFlagsRef.current.focusAfter || focusAfter,
    }
    // 非拖动场景每帧最多计算一次字符网格；拖动结束由 settle 统一提交。
    if (fitRafRef.current !== 0 || isPanelResizing()) return
    fitRafRef.current = window.requestAnimationFrame(() => {
      fitRafRef.current = 0
      if (isPanelResizing()) return
      const flags = pendingFitFlagsRef.current
      pendingFitFlagsRef.current = { refresh: false, focusAfter: false }
      fitNow(flags.refresh, flags.focusAfter)
    })
  }, [fitNow])

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
      // 【终端防闪烁关键配置，请勿改回 false】拖动开始时 panelResize.ts 要把
      // 当前 WebGL canvas 复制成静态快照；preserveDrawingBuffer=false 时浏览器
      // 合成后允许丢弃像素，快照会随机变成空白。修改前必须替换整套快照方案。
      const webgl = new WebglAddon(true)
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
      // 拖动时合并 ConPTY 整屏刷新；暂停或松手后再发送最新行列。
      if (isPanelResizing()) {
        schedulePtyResize({ cols, rows })
        return
      }
      clearPtyResizeTimer()
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
      // 【终端防闪烁关键逻辑，请勿移除】拖动期间严禁在 ResizeObserver/rAF 中
      // 调用 fit/term.resize。WebGL canvas 会立刻清空，而内容下一帧才重绘，
      // WebView2 因此会显示空白帧。拖动的最终网格只能由下面的 settle 提交。
      if (isPanelResizing()) return
      scheduleFit()
    })
    if (containerRef.current) ro.observe(containerRef.current)

    const onPanelResizeBegin = () => {
      if (isActiveRef.current) term.options.cursorBlink = false
    }
    const onPanelResizeSettle = (event: Event) => {
      if (!isActiveRef.current) return
      if (fitRafRef.current !== 0) {
        window.cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = 0
      }
      const flags = pendingFitFlagsRef.current
      pendingFitFlagsRef.current = { refresh: false, focusAfter: false }
      // 【终端防闪烁关键时序，请勿改成固定 rAF】先订阅 onRender，再执行最终
      // resize；panelResize.ts 会一直覆盖旧画面，直到这个 Promise 完成并再合成一帧。
      const renderReady = waitForTerminalRender(term, () => {
        let requestedRender = fitSettledPanelGrid()
        const pending = useTerminalStore
          .getState()
          .terminals.find(tab => tab.id === terminalId)?.ptySpawnPending
        if (pending) void spawnPendingTerminal(terminalId, term.cols, term.rows)
        if (flags.refresh) {
          term.refresh(0, term.rows - 1)
          term.scrollToBottom()
          requestedRender = true
        }
        if (flags.focusAfter && isActiveRef.current) term.focus()
        return requestedRender
      })
      const detail = (event as CustomEvent<PanelResizeSettleDetail>).detail
      detail?.waitUntil(renderReady)

      // PTY/TUI 整屏重排必须与本地 WebGL 换帧错开；onResize 已记录最终尺寸，
      // 这里从画面就绪时重新开始 100/500ms 合并窗口，不能在 end 中立即 flush。
      void renderReady.then(() => {
        const pendingSize = pendingPtySizeRef.current
        if (pendingSize && isActiveRef.current) schedulePtyResize(pendingSize)
      })
    }
    const onPanelResizeEnd = () => {
      term.options.cursorBlink = getTerminalCursorBlinking()
      // 不要在这里 flush PTY resize：它会与刚揭开的 WebGL 画面同时触发 TUI
      // 整屏刷新。等待 schedulePtyResize 的合并计时器自然提交最终尺寸。
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
      clearPtyResizeTimer()
      pendingPtySizeRef.current = null
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
  }, [
    clearBuffer,
    clearPtyResizeTimer,
    copySelection,
    fitSettledPanelGrid,
    isTerminalWritable,
    openSearch,
    pasteFromClipboard,
    resizeTerminal,
    scheduleFit,
    schedulePtyResize,
    spawnPendingTerminal,
    terminalId,
    writeToTerminal,
  ])

  useEffect(() => {
    if (!isActive) return
    // Size-only: fit without full refresh/scrollToBottom (avoids end-of-drag flash).
    scheduleFit(false, false)
  }, [isActive, layoutKey, scheduleFit])

  useEffect(() => {
    if (!isActive) return
    scheduleFit(true, true)
  }, [isActive, scheduleFit])

  // Restart / deferred create: fit again as soon as a PTY is requested.
  useEffect(() => {
    if (!ptySpawnPending) return
    scheduleFit(true, isActiveRef.current)
  }, [ptySpawnPending, scheduleFit])

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
  }, [clearBuffer, openSearch, terminalId])

  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) {
      queueMicrotask(() => resetSearchMatch())
      searchAddonRef.current?.clearDecorations()
      return
    }
    searchAddonRef.current?.findNext(searchQuery, terminalSearchOptions(true))
  }, [resetSearchMatch, searchQuery, searchOpen])

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
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          items: contextMenuItems(),
        })
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
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
