import TerminalExitNotice from './TerminalExitNotice'
import TerminalConnectionNotice from './TerminalConnectionNotice'
import { exportTerminalDiagnostics } from '@/lib/terminal/terminalDiagnostics'
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  consumeTerminalDisconnectNotice,
  hasTerminalScrollback,
  setTerminalViewGrid,
  subscribeTerminalOutput,
  useTerminalStore,
} from '../store/terminalStore'
import { setTerminalOutputPaused } from '@/lib/ipc/terminal'
import { TerminalWriteFlow } from '@/lib/terminal/terminalWriteFlow'
import { terminalRestoreNotices } from '@/lib/terminal/terminalRestorePlan'
import { formatTerminalQuote } from '@/lib/terminal/terminalQuote'
import {
  protectTerminalSelectionMenu,
  shouldUseTerminalContextMenu,
} from '@/lib/terminal/terminalSelectionMenu'
import { useProjectStore } from '../store/projectStore'
import {
  FONT_SETTINGS_EVENT,
  stepTerminalFontSize,
  getResolvedTerminalFont,
  getResolvedTerminalFontSize,
} from '../lib/fontSettings'
import { THEME_SETTINGS_EVENT, getResolvedTheme } from '../lib/themeSettings'
import { deferToNativeContextMenuInDev, shouldShowAppContextMenu } from '../lib/devBuild'
import {
  TERMINAL_SCROLLBACK_SETTINGS_EVENT,
  getTerminalScrollback,
} from '@/lib/terminal/terminalScrollbackSettings'
import {
  TERMINAL_CURSOR_SETTINGS_EVENT,
  getTerminalCursorBlinking,
} from '@/lib/terminal/terminalCursorSettings'
import {
  TERMINAL_CLEAR_EVENT,
  TERMINAL_RESET_EVENT,
  TERMINAL_SEARCH_EVENT,
  type TerminalViewBridgeDetail,
} from '@/lib/terminal/terminalViewBridge'
import {
  markTerminalCommandFinished,
  markTerminalCommandStarted,
} from '@/lib/terminal/terminalCommandActivity'
import { createTerminalZoomWheel } from '@/lib/terminal/terminalZoomWheel'
import { MATERIAL_FOREST as M } from '../lib/materialForestTheme'
import {
  restoredExitRecovery,
  shouldKeepShellAfterExit,
} from '@/lib/terminal/terminalShellLifecycle'
import { terminalSessionOpen } from '../lib/ipc/terminal'
import {
  isPanelResizing,
  PANEL_RESIZE_BEGIN_EVENT,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_SETTLE_EVENT,
  type PanelResizeSettleDetail,
} from '../lib/panelResize'
import {
  getTerminalPtyResizeDelay,
  getTerminalRedrawRevealMaxMs,
  isValidTerminalGridSize,
  shouldRevealTerminalAfterRedraw,
  shouldSendPtyResizeNow,
  terminalGridSizeChanged,
  type TerminalGridSize,
} from '@/lib/terminal/terminalResizePolicy'
import { waitForTerminalRender } from '@/lib/terminal/terminalRenderBarrier'
import {
  acquireTerminalWebglSlot,
  releaseTerminalWebglSlot,
  touchTerminalWebglSlot,
} from '@/lib/terminal/terminalWebglBudget'
import { createGlyphAtlasRepairScheduler, type GlyphAtlasRepairScheduler } from '@/lib/terminal/terminalGlyphAtlasRepair'
import { registerTerminalOscHandlers } from '../utils/terminalOsc'
import { shouldApplyOscTabTitle } from '../utils/terminalName'
import { translate } from '../lib/i18n'
import { isSshResource, isTauri } from '../lib/tauri'
import { TERMINAL_DROP_ATTR, confirmClearSshTerminalPasteUploads } from '../lib/sshTerminalPaste'
import { getTerminalSshUploadOnPaste } from '../lib/terminal/terminalSshUploadSettings'
import { getTerminalLargePasteAsFile } from '../lib/terminal/terminalLargePasteSettings'
import { terminalContent } from '../lib/terminal/terminalContent'
import { exportTerminalContent } from '../lib/terminal/terminalExport'
import {
  isTerminalNewlineShortcut,
  TERMINAL_NEWLINE_INPUT,
} from '../lib/terminal/terminalNewline'
import {
  isSameTerminalSession,
  prepareTerminalAttachments,
  storeAttachmentFiles,
  terminalClipboardPaths,
} from '../lib/terminal/terminalAttachments'
import { formatPasteSize, largePasteFileName, largePasteStats } from '../lib/terminal/largePaste'
import { confirmDialog } from '../store/confirmStore'
import { copyToClipboard } from '../utils/fileReferences'
import { logicalDropPoint } from '../utils/sshExplorerDrop'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import TerminalSearchBar from './TerminalSearchBar'
import TerminalComposer from './TerminalComposer'
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

function writeFinishedTaskHint(term: XTerm) {
  term.writeln(
    `\x1b[90m${translate('按 Ctrl+C 在当前标签进入命令行，或点标签「重启」重新运行任务。')}\x1b[0m`
  )
}

// Backgrounds match App.css --color-bg-deep so the caret/outline stays visible.
const DARK_THEME = {
  background: '#181818',
  foreground: '#d4d4d4',
  cursor: '#aeafad',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  scrollbarSliderBackground: 'rgba(212, 212, 212, 0.28)',
  scrollbarSliderHoverBackground: 'rgba(212, 212, 212, 0.45)',
  scrollbarSliderActiveBackground: 'rgba(212, 212, 212, 0.6)',
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
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#b9d6f5',
  scrollbarSliderBackground: 'rgba(31, 31, 31, 0.25)',
  scrollbarSliderHoverBackground: 'rgba(31, 31, 31, 0.42)',
  scrollbarSliderActiveBackground: 'rgba(31, 31, 31, 0.55)',
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

const FOREST_SCROLLBAR = {
  idle: `${M.foreground}47`,
  hover: `${M.foreground}73`,
  active: `${M.foreground}99`,
}

const FOREST_THEME = {
  background: M.contrast,
  foreground: M.foreground,
  cursor: M.accent,
  cursorAccent: M.contrast,
  selectionBackground: M.selectionBg,
  scrollbarSliderBackground: FOREST_SCROLLBAR.idle,
  scrollbarSliderHoverBackground: FOREST_SCROLLBAR.hover,
  scrollbarSliderActiveBackground: FOREST_SCROLLBAR.active,
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
  if (resolved === 'olive' || (resolved as string) === 'forest') return FOREST_THEME
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

/** 单个终端 WebGL 上下文连续丢失这么多次后不再尝试，保持 DOM 渲染。 */
const TERMINAL_WEBGL_MAX_CONTEXT_LOSSES = 3
const TERMINAL_WEBGL_RETRY_MS = 1000
/** 区分同一终端的多次挂载（StrictMode / 快速重挂），避免互相归还对方的预算槽位。 */
let terminalWebglMountSeq = 0

interface TerminalViewProps {
  terminalId: string
  layoutKey?: string
  isActive?: boolean
}

export default function TerminalView({
  terminalId,
  layoutKey,
  isActive = false,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const keepScrollOnFitRef = useRef(false)
  const fitRafRef = useRef(0)
  const ptyResizeTimerRef = useRef<number | null>(null)
  const pendingFitFlagsRef = useRef({ refresh: false, focusAfter: false })
  const pendingPtySizeRef = useRef<{ cols: number; rows: number } | null>(null)
  /** 上一次真正写入 PTY 的尺寸时间，用于合并连续的 SIGWINCH。 */
  const ptyResizeSentAtRef = useRef(0)
  const lastFitSizeRef = useRef({ w: 0, h: 0 })
  /** 重挂回放后停在全屏 TUI 上，等网格就绪后让程序整屏重绘一次。 */
  const redrawPendingRef = useRef(false)
  /**
   * 正在解析的屏幕快照数。快照按 daemon 网格排版、整行依赖自动折行，xterm 又是分帧异步
   * 解析的：解析完之前任何一次 fit 改了列数，后半段就会逐行错位成阶梯。期间推迟所有 fit。
   */
  const screenWriteLockRef = useRef(0)
  /** 最近一次 PTY 输出解析完成的时间，用于判断 TUI 重绘是否已经停下来。 */
  const lastOutputParsedAtRef = useRef(0)
  const revealTimerRef = useRef<number | null>(null)
  /** 申请或刷新 WebGL 渲染（预算见 terminalWebglBudget）；挂载时由主 effect 赋值。 */
  const ensureWebglRef = useRef<() => void>(() => {})
  const isActiveRef = useRef(isActive)
  const previousStatusRef = useRef<string | undefined>(undefined)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  /** 长文本面板是非模态的：所属终端被切走（标签/项目/布局）时跟着隐藏，切回再出现。 */
  const [composerHidden, setComposerHidden] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1)
  const [searchMatchTotal, setSearchMatchTotal] = useState(0)
  const writeToTerminal = useTerminalStore(s => s.writeToTerminal)
  const resizeTerminal = useTerminalStore(s => s.resizeTerminal)
  const redrawTerminal = useTerminalStore(s => s.redrawTerminal)
  const spawnPendingTerminal = useTerminalStore(s => s.spawnPendingTerminal)
  const terminal = useTerminalStore(s => s.terminals.find(tab => tab.id === terminalId))
  const ptySpawnPending = terminal?.ptySpawnPending === true

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  const isTerminalWritable = useCallback(() => {
    const tab = useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)
    return tab?.status === 'running' && !tab.ptySpawnPending
  }, [terminalId])

  const prepareAttachmentPaths = useCallback(
    async (paths: string[]) => {
      const target = useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)
      if (!target || !isTerminalWritable()) throw new Error(translate('目标终端已不可用'))
      const text = await prepareTerminalAttachments(target, paths)
      if (paths.length && !text) throw new Error(translate('附件准备失败，请重试'))
      if (
        !isSameTerminalSession(
          target,
          useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)
        )
      ) {
        throw new Error(translate('目标终端已不可用'))
      }
      return text
    },
    [isTerminalWritable, terminalId]
  )

  const copySelection = useCallback(async (selection = xtermRef.current?.getSelection()) => {
    if (!selection) return
    try {
      await copyToClipboard(selection)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', translate('复制失败：{error}', { error: String(error) }))
    }
  }, [])

  const pasteFromClipboard = useCallback(
    async (event?: ClipboardEvent) => {
      const term = xtermRef.current
      if (!term || !isTerminalWritable()) return
      const tab = useTerminalStore.getState().terminals.find(item => item.id === terminalId)
      const text = event?.clipboardData?.getData('text/plain')
      try {
        if (tab && (!isSshResource(tab.cwd) || getTerminalSshUploadOnPaste())) {
          const files = await terminalClipboardPaths(event)
          if (files.length > 0) {
            const attachment = await prepareTerminalAttachments(tab, files)
            if (
              attachment &&
              xtermRef.current === term &&
              isSameTerminalSession(
                tab,
                useTerminalStore.getState().terminals.find(item => item.id === terminalId)
              )
            )
              term.paste(attachment)
            return
          }
        }
        const pastedText = text || (await navigator.clipboard.readText())
        const stillSameSession = () =>
          !!tab &&
          xtermRef.current === term &&
          isSameTerminalSession(
            tab,
            useTerminalStore.getState().terminals.find(item => item.id === terminalId)
          )
        if (!pastedText || !stillSameSession()) return
        // 超大文本一次灌进 Claude Code 等 TUI 会卡住数秒；询问是否存为文件、只粘贴路径。
        // SSH 未开启粘贴上传时无法把文件送到远端，保持直接粘贴。
        const large = largePasteStats(pastedText)
        if (large && tab && (!isSshResource(tab.cwd) || getTerminalSshUploadOnPaste())) {
          // 设置「大段粘贴存为文件」开启时不再询问，直接存文件。
          const choice = getTerminalLargePasteAsFile() ? true : await confirmDialog({
            title: translate('粘贴大段文本'),
            message: translate('将粘贴 {lines} 行、约 {size} 文本。', {
              lines: large.lines,
              size: formatPasteSize(large.chars),
            }),
            detail: translate(
              '直接粘贴会让 Claude Code 等终端程序卡住一段时间；存为文件后只粘贴文件路径，程序可读取完整内容。'
            ),
            kind: 'info',
            confirmLabel: translate('存为文件并粘贴路径'),
            altLabel: translate('仍然直接粘贴'),
          })
          if (choice === true) {
            const file = new File([pastedText], largePasteFileName(), { type: 'text/plain' })
            const attachment = await prepareTerminalAttachments(tab, await storeAttachmentFiles([file]))
            if (attachment && stillSameSession()) term.paste(attachment)
          } else if (choice === 'alt' && stillSameSession()) {
            term.paste(pastedText)
          }
          if (xtermRef.current === term) term.focus()
          return
        }
        term.paste(pastedText)
      } catch (error) {
        useProjectStore
          .getState()
          .pushToast('error', translate('粘贴失败：{error}', { error: String(error) }))
      }
    },
    [isTerminalWritable, terminalId]
  )

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

  const resetTerminalView = useCallback(() => {
    const term = xtermRef.current
    if (!term) return
    term.reset()
    term.scrollToBottom()
    searchAddonRef.current?.clearDecorations()
    resetSearchMatch()
  }, [resetSearchMatch])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    resetSearchMatch()
  }, [resetSearchMatch])

  const insertTerminalNewline = useCallback(() => {
    if (!isTerminalWritable()) return
    void writeToTerminal(terminalId, TERMINAL_NEWLINE_INPUT)
  }, [isTerminalWritable, terminalId, writeToTerminal])

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

  // Capture once: TUI output can invalidate the live selection while the menu is open.
  const contextMenuItems = useCallback((selection: string, screen: string): ContextMenuItem[] => [
    {
      label: translate('复制'),
      shortcut: 'Ctrl+C',
      disabled: !selection,
      action: () => {
        void copySelection(selection)
      },
    },
    {
      // 引用选中内容到 AI CLI 输入框；只在程序开启 bracketed paste 时可用，
      // 否则多行会被逐行执行（普通 Shell 里 `> xxx` 还会变成重定向）。
      label: translate('添加到对话'),
      disabled:
        !formatTerminalQuote(selection) ||
        !isTerminalWritable() ||
        !xtermRef.current?.modes.bracketedPasteMode,
      action: () => {
        const term = xtermRef.current
        const quote = formatTerminalQuote(selection)
        if (!term || !quote || !isTerminalWritable() || !term.modes.bracketedPasteMode) return
        term.clearSelection()
        term.paste(quote)
        term.focus()
      },
    },
    {
      label: translate('复制当前屏幕'),
      disabled: !screen,
      action: () => {
        void copySelection(screen)
      },
    },
    {
      label: translate('导出终端内容…'),
      disabled: !xtermRef.current,
      action: () => {
        const term = xtermRef.current
        if (!term) return
        // Snapshot before the asynchronous save dialog; avoid scanning history on every right-click.
        const buffer = terminalContent(term, 'buffer')
        const name =
          useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)?.name ??
          'terminal'
        void exportTerminalContent(buffer, name)
          .then(saved => {
            if (saved) useProjectStore.getState().pushToast('success', translate('终端内容已导出'))
          })
          .catch(error =>
            useProjectStore
              .getState()
              .pushToast('error', translate('导出失败：{error}', { error: String(error) }))
          )
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
      label: translate('换行'),
      shortcut: 'Ctrl+Enter',
      disabled: !isTerminalWritable(),
      action: insertTerminalNewline,
    },
    {
      label: translate('编辑长文本'),
      disabled: !isTerminalWritable(),
      action: () => {
        setComposerHidden(false)
        setComposerOpen(true)
        // 已打开时（非模态，可能被终端抢走焦点）重新聚焦到面板输入框。
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLTextAreaElement>(
              `[data-terminal-composer="${CSS.escape(terminalId)}"] textarea`
            )
            ?.focus()
        })
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
    ...(isSshResource(
      useTerminalStore.getState().terminals.find(item => item.id === terminalId)?.cwd ?? ''
    )
      ? [
          {
            label: translate('清理远程粘贴文件'),
            separatorBefore: true,
            action: () => {
              const tab = useTerminalStore.getState().terminals.find(item => item.id === terminalId)
              if (tab) void confirmClearSshTerminalPasteUploads(tab.cwd)
            },
          },
        ]
      : []),
  ], [
    clearBuffer,
    copySelection,
    insertTerminalNewline,
    isTerminalWritable,
    openSearch,
    pasteFromClipboard,
    selectAll,
    terminalId,
  ])

  const clearPtyResizeTimer = useCallback(() => {
    if (ptyResizeTimerRef.current === null) return
    window.clearTimeout(ptyResizeTimerRef.current)
    ptyResizeTimerRef.current = null
  }, [])

  const commitGridSize = useCallback((next: TerminalGridSize) => {
    const term = xtermRef.current
    // next 总是按容器算出的网格：登记给 store，恢复/兜底启动按它接回而不是默认 80x24。
    if (term) setTerminalViewGrid(terminalId, next)
    if (!term || !terminalGridSizeChanged({ cols: term.cols, rows: term.rows }, next)) return false
    // 快照解析完会补一次 fit（见下方 onScreen），这里先不动网格。
    if (screenWriteLockRef.current > 0) return false
    // 直接 resize 便于准确判断是否需要等待下方的 onRender 屏障。
    term.resize(next.cols, next.rows)
    return true
  }, [terminalId])

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
    if (!pending) return
    ptyResizeSentAtRef.current = Date.now()
    void resizeTerminal(terminalId, pending.cols, pending.rows)
  }, [clearPtyResizeTimer, resizeTerminal, terminalId])

  const schedulePtyResize = useCallback(
    (next: TerminalGridSize) => {
      const term = xtermRef.current
      pendingPtySizeRef.current = next
      clearPtyResizeTimer()
      const delay = getTerminalPtyResizeDelay(term?.buffer.active.type ?? 'normal')
      ptyResizeTimerRef.current = window.setTimeout(() => {
        ptyResizeTimerRef.current = null
        flushPendingPtyResize()
      }, delay)
    },
    [clearPtyResizeTimer, flushPendingPtyResize]
  )

  /**
   * 重挂回放的是旧网格下的原始字节，全屏 TUI 在重绘前会先显示一帧错位画面；
   * 重绘过程中 rows-1 → rows 的两次 SIGWINCH 也各自整屏输出一次。
   * 这段时间先把画面透明化（保留焦点能力，不用 visibility），等输出安静后再揭开。
   */
  const setReplayMasked = useCallback((masked: boolean) => {
    const container = containerRef.current
    if (!container) return
    if (!masked && revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }
    container.style.opacity = masked ? '0' : ''
  }, [])

  const revealAfterRedraw = useCallback(
    (startedAt: number, redrawSent: boolean) => {
      const term = xtermRef.current
      if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
      if (!term || xtermRef.current !== term) return
      // 没有真正发出 SIGWINCH 就不会有回包，直接揭开。
      if (!redrawSent) {
        setReplayMasked(false)
        return
      }
      const tab = useTerminalStore.getState().terminals.find(item => item.id === terminalId)
      const maxMs = getTerminalRedrawRevealMaxMs(isSshResource(tab?.cwd ?? ''))
      const tick = () => {
        revealTimerRef.current = null
        if (xtermRef.current !== term) return
        if (
          shouldRevealTerminalAfterRedraw({
            startedAt,
            lastOutputAt: lastOutputParsedAtRef.current,
            now: Date.now(),
            maxMs,
          })
        ) {
          setReplayMasked(false)
          return
        }
        revealTimerRef.current = window.setTimeout(tick, 16)
      }
      tick()
    },
    [setReplayMasked, terminalId]
  )

  const flushPendingRedraw = useCallback(() => {
    const term = xtermRef.current
    const container = containerRef.current
    // 不要求激活：单窗格里不可见的标签也有真实尺寸，后台重绘好切回来即是最终画面。
    if (!redrawPendingRef.current || !term) return
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
    if (screenWriteLockRef.current > 0) return
    redrawPendingRef.current = false
    // 回放的旧字节按旧网格排版，而当前尺寸与 PTY 相同时 resize 会被去重，
    // TUI 收不到 SIGWINCH 就不会重绘，画面一直错位（切换项目后常见）。
    clearPtyResizeTimer()
    pendingPtySizeRef.current = null
    const startedAt = Date.now()
    ptyResizeSentAtRef.current = startedAt
    // 重绘分两步、中间隔开（见 store 的 PTY_RESIZE_MIN_GAP_MS）：从最后一步下发后才开始
    // 等输出安静，免得第一步的回包一安静就揭开，露出中间尺寸的那一帧。
    void redrawTerminal(terminalId, term.cols, term.rows)
      .catch(() => false)
      .then(sent => revealAfterRedraw(sent ? Date.now() : startedAt, sent))
  }, [clearPtyResizeTimer, redrawTerminal, revealAfterRedraw, terminalId])

  const fitNow = useCallback(
    (refresh = false, focusAfter = false) => {
      const container = containerRef.current
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
      const term = xtermRef.current
      if (!term) return
      const w = container.clientWidth
      const h = container.clientHeight
      // 游离时收到快照会把网格改成 daemon 尺寸并挂起重绘，挂回槽位时容器尺寸可能没变，
      // 这时也不能跳过，否则网格停在快照尺寸、TUI 收不到重绘。
      if (
        !refresh &&
        !redrawPendingRef.current &&
        w === lastFitSizeRef.current.w &&
        h === lastFitSizeRef.current.h
      ) {
        return
      }
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
        flushPendingRedraw()
        if (refresh) {
          term.refresh(0, term.rows - 1)
          if (!keepScrollOnFitRef.current) term.scrollToBottom()
          keepScrollOnFitRef.current = false
        }
        if (focusAfter && isActiveRef.current) term.focus()
      } catch {}
    },
    [commitGridSize, flushPendingRedraw, readProposedGridSize, spawnPendingTerminal, terminalId]
  )

  const scheduleFit = useCallback(
    (refresh = false, focusAfter = false) => {
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
    },
    [fitNow]
  )

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: getTerminalCursorBlinking(),
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      fontSize: getResolvedTerminalFontSize(),
      fontFamily: getResolvedTerminalFont(),
      // 中文和长输出在 1.0 下过于拥挤；对比度目标与同样基于 xterm.js 的 VS Code 一致。
      lineHeight: 1.1,
      letterSpacing: 0,
      fontWeightBold: '600',
      minimumContrastRatio: 4.5,
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
    const unicode11 = new Unicode11Addon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(linkAddon)
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    term.open(containerRef.current)
    searchAddonRef.current = searchAddon
    const searchResultsSub = searchAddon.onDidChangeResults(event => {
      setSearchMatchIndex(event.resultIndex)
      setSearchMatchTotal(event.resultCount)
    })

    // Prefer WebGL so customGlyphs apply; fall back silently to the DOM renderer.
    // Dynamic import keeps the heavy addon out of the initial xterm chunk.
    // WebGL 上下文有全局上限，按 terminalWebglBudget 预算申请：超额时回收不可见终端，
    // 被回收或上下文丢失的终端在重新可见时再申请。
    let webglCancelled = false
    let webgl: { dispose(): void } | null = null
    // 字形图集合并后的自愈（见 terminalGlyphAtlasRepair）；随 WebGL addon 一起创建与释放。
    let atlasRepair: GlyphAtlasRepairScheduler | null = null
    let webglLoading = false
    let webglLosses = 0
    const webglSlotKey = `${terminalId}#${++terminalWebglMountSeq}`
    const isTerminalVisible = () => {
      const el = containerRef.current
      return Boolean(
        el && el.offsetParent !== null && window.getComputedStyle(el).visibility !== 'hidden'
      )
    }
    const releaseWebgl = () => {
      const addon = webgl
      webgl = null
      atlasRepair?.dispose()
      atlasRepair = null
      releaseTerminalWebglSlot(webglSlotKey)
      try {
        addon?.dispose()
      } catch {}
    }
    const ensureWebgl = () => {
      if (webglCancelled) return
      if (webgl) {
        touchTerminalWebglSlot(webglSlotKey)
        return
      }
      if (webglLoading || webglLosses >= TERMINAL_WEBGL_MAX_CONTEXT_LOSSES) return
      webglLoading = true
      void import('@xterm/addon-webgl')
        .then(({ WebglAddon }) => {
          webglLoading = false
          if (webglCancelled || webgl) return
          if (!acquireTerminalWebglSlot(webglSlotKey, isTerminalVisible, releaseWebgl)) return
          try {
            // 【终端防闪烁关键配置，请勿改回 false】拖动开始时 panelResize.ts 要把
            // 当前 WebGL canvas 复制成静态快照；preserveDrawingBuffer=false 时浏览器
            // 合成后允许丢弃像素，快照会随机变成空白。修改前必须替换整套快照方案。
            const addon = new WebglAddon(true)
            addon.onContextLoss(() => {
              webglLosses += 1
              releaseWebgl()
              // GPU 重置后稍等再申请；不可见的终端等下次激活或可见时再申请。
              window.setTimeout(() => {
                if (isTerminalVisible()) ensureWebgl()
              }, TERMINAL_WEBGL_RETRY_MS)
            })
            term.loadAddon(addon)
            webgl = addon
            const repair = createGlyphAtlasRepairScheduler(() => addon.clearTextureAtlas())
            atlasRepair = repair
            // 图集页被移除 = 发生了合并：本终端未变化单元格的纹理坐标已失效，重建图集与模型。
            addon.onRemoveTextureAtlasCanvas(() => repair.schedule())
          } catch {
            // DOM renderer remains active.
            releaseTerminalWebglSlot(webglSlotKey)
          }
        })
        .catch(() => {
          // DOM renderer remains active.
          webglLoading = false
        })
    }
    ensureWebglRef.current = ensureWebgl
    ensureWebgl()

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    const tab = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
    previousStatusRef.current = tab?.status
    const hadRestoredScrollback = hasTerminalScrollback(terminalId)
    // Restored scrollback is written via subscribeTerminalOutput; only show a
    // status line when there is nothing to replay (or after restore note).
    if (
      tab?.status === 'exited' &&
      !consumeTerminalDisconnectNotice(terminalId) &&
      !hadRestoredScrollback
    ) {
      const detail =
        tab.exitCode === null
          ? translate('进程未启动')
          : translate('进程已退出，退出码 {code}', { code: String(tab.exitCode) })
      term.writeln(`\x1b[90m[${detail}${translate('，可从终端标签重启')}]\x1b[0m`)
      if (tab && !shouldKeepShellAfterExit(tab)) writeFinishedTaskHint(term)
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
      if (isTerminalNewlineShortcut(event)) {
        event.preventDefault()
        if (!event.repeat) insertTerminalNewline()
        return false
      }
      if (mod && !event.altKey && key === 'c') {
        if (term.hasSelection() || event.shiftKey) {
          // Native writing owns this copy; a later browser copy must not overwrite it.
          event.preventDefault()
          event.stopPropagation()
          if (term.hasSelection()) void copySelection()
          return false
        }
        if (event.ctrlKey) {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) {
            void writeToTerminal(terminalId, '\x03')
          }
          return false
        }
      }
      // Let the OS deliver a paste event, including screenshot/File payloads.
      // Handling Ctrl+V here would discard that payload and paste twice on some hosts.
      if ((mod && !event.altKey && key === 'v') || (event.shiftKey && event.key === 'Insert')) {
        // Skip xterm's Ctrl+V -> SYN translation while preserving the browser's paste action.
        return false
      }
      return true
    })

    const onPaste = (event: ClipboardEvent) => {
      if (!isTerminalWritable()) return
      event.preventDefault()
      event.stopPropagation()
      void pasteFromClipboard(event)
    }

    // 从截图工具等其它窗口点回终端时，WebView 激活窗口后会把焦点还给上次聚焦的元素
    // （如资源管理器），覆盖这里的 focus；随后的 Ctrl+V 就被资源管理器当成上传处理。
    // 因此在焦点恢复完成后再补一次，期间用户点了别处则不再抢焦点。
    let focusClaim = 0
    const onMouseDown = () => {
      const claim = ++focusClaim
      term.focus()
      const reclaim = () => {
        if (claim !== focusClaim || xtermRef.current !== term) return
        if (!container.contains(document.activeElement)) term.focus()
      }
      window.requestAnimationFrame(reclaim)
      window.setTimeout(reclaim, 120)
    }
    const onWindowPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !container.contains(event.target)) focusClaim += 1
    }

    const container = containerRef.current
    container.addEventListener('paste', onPaste, true)
    const disposeSelectionMenuGuard = protectTerminalSelectionMenu(
      container,
      () => term.getSelection(),
      () => !deferToNativeContextMenuInDev(),
      (event, selection) => setContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: contextMenuItems(selection, terminalContent(term, 'screen')),
      })
    )
    container.addEventListener('mousedown', onMouseDown)
    window.addEventListener('pointerdown', onWindowPointerDown, true)

    // 必须在捕获阶段拦截：否则 xterm 会把滚轮滚动或转发给 TUI，WebView 也会缩放整页。
    const zoomWheel = createTerminalZoomWheel()
    const onZoomWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const step = zoomWheel(event)
      if (step) stepTerminalFontSize(step)
    }
    container.addEventListener('wheel', onZoomWheel, { capture: true, passive: false })

    const updateFont = () => {
      // 正在翻看历史时改字号不能跳回底部。
      const { viewportY, baseY } = term.buffer.active
      keepScrollOnFitRef.current = viewportY < baseY
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
      window.setTimeout(() => scheduleFit(true, false), ms)
    )
    void document.fonts?.ready?.then(() => {
      term.options.fontFamily = getResolvedTerminalFont()
      scheduleFit(true, false)
    })

    term.onResize(({ cols, rows }) => {
      // 拖动时合并 ConPTY 整屏刷新；暂停或松手后再发送最新行列。
      // 拖动结束后、启动字体加载、系统窗口连续缩放都会在很短时间内产生多次网格
      // 变化，每条 SIGWINCH 都让 TUI 整屏重排一次（Claude Code 还会把每次重排
      // 追加进 scrollback，见 anthropics/claude-code#46834）。因此只在「安静期」
      // 后的第一次变化立即提交，300ms 内的其余变化合并成一次。
      if (isPanelResizing() || !shouldSendPtyResizeNow(ptyResizeSentAtRef.current, Date.now())) {
        schedulePtyResize({ cols, rows })
        return
      }
      pendingPtySizeRef.current = { cols, rows }
      flushPendingPtyResize()
    })
    term.onData(data => {
      const status = useTerminalStore
        .getState()
        .terminals.find(tab => tab.id === terminalId)?.status
      if (status !== 'exited' || data === '\x03') writeToTerminal(terminalId, data)
    })
    // 程序通过 OSC 设置窗口标题时自动更新标签名（如 opencode）；运行任务终端不跟随。
    // The parser gate is enabled after history has been parsed, not merely enqueued.
    let clipboardWritesEnabled = false
    const disposeOscHandlers = registerTerminalOscHandlers(term.parser, {
      onClipboardWrite: text => {
        if (!clipboardWritesEnabled) return
        void copyToClipboard(text).catch(error =>
          useProjectStore
            .getState()
            .pushToast('error', translate('复制失败：{error}', { error: String(error) }))
        )
      },
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
    // xterm 积压超过高水位时暂停 PTY 读取，保证按键回显不被大段输出淹没。
    const flowHolder = {}
    const writeFlow = new TerminalWriteFlow(paused =>
      setTerminalOutputPaused(terminalId, flowHolder, paused)
    )
    let unsubscribeOutput: (() => void) | undefined
    const subscribeTimer = window.setTimeout(() => {
      // 回放前先按容器定好行列：否则历史字节会写进默认 80x20 网格，之后再 fit 也无法还原。
      // 视图由 TerminalHost 常驻，只有应用启动或新建标签时才走这里的回放。
      resizeGridFromContainer()
      setReplayMasked(true)
      let replaying = true
      unsubscribeOutput = subscribeTerminalOutput(terminalId, data => {
        const size = data.length
        const isReplay = replaying
        writeFlow.written(size)
        term.write(data, () => {
          writeFlow.parsed(size)
          lastOutputParsedAtRef.current = Date.now()
          if (!isReplay || xtermRef.current !== term) return
          // 只对全屏 TUI（备用缓冲区）补一次重绘；普通 Shell 的回放本身就是最终画面。
          if (term.buffer.active.type !== 'alternate') return
          redrawPendingRef.current = true
          scheduleFit(true, false)
        })
      }, snapshot => {
        // daemon 接回下发的屏幕快照按 daemon 网格排版（同 VS Code 的 replay 事件）：
        // 网格不同就先按原网格写入，再由 fit 正常 resize，让 TUI 按新尺寸重画；
        // 期间用遮罩盖住，揭开由 flushPendingRedraw 等重绘回包后负责。
        // 普通屏幕的快照自带清屏，会抹掉当前视口：先把视口里已有的行推进滚动历史，
        // 断线前的输出不丢，快照只换掉当前屏幕。
        const buffer = term.buffer.active
        if (
          snapshot.data.startsWith('\x1b[?1049l') &&
          buffer.type === 'normal' &&
          (buffer.baseY > 0 || buffer.cursorY > 0 || buffer.cursorX > 0)
        ) {
          const used = Math.min(term.rows, buffer.cursorY + 1)
          term.write(`\x1b[${term.rows};1H${'\n'.repeat(used)}`)
        }
        const fitsGrid = term.cols === snapshot.cols && term.rows === snapshot.rows
        if (!fitsGrid) {
          setReplayMasked(true)
          term.resize(snapshot.cols, snapshot.rows)
        }
        screenWriteLockRef.current += 1
        term.write(snapshot.data, () => {
          screenWriteLockRef.current = Math.max(0, screenWriteLockRef.current - 1)
          if (xtermRef.current !== term) return
          if (!fitsGrid) redrawPendingRef.current = true
          // 补上解析期间被推迟的 fit；网格不同时由它 resize 并触发 TUI 重绘。
          scheduleFit(true, false)
        })
      })
      replaying = false
      term.write('', () => {
        clipboardWritesEnabled = true
        // 普通 Shell 的回放就是最终画面；全屏 TUI 等 flushPendingRedraw 重绘后再揭开。
        if (!redrawPendingRef.current && xtermRef.current === term) setReplayMasked(false)
      })
      const restored = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
      if (restored?.status !== 'exited' || !hadRestoredScrollback) return
      void (async () => {
        let sessionOpen: boolean | null = null
        try {
          sessionOpen = await terminalSessionOpen(terminalId)
        } catch {
          sessionOpen = null
        }
        if (xtermRef.current !== term) return
        const latest = useTerminalStore.getState().terminals.find(t => t.id === terminalId)
        if (!latest || latest.status !== 'exited') return
        const pendingRestoreNote = translate(terminalRestoreNotices(latest).history)
        if (sessionOpen === null) {
          if (latest.awaitingRestoreSpawn) {
            term.writeln(`\r\n\x1b[90m[${pendingRestoreNote}]\x1b[0m`)
          }
          return
        }
        const recovery = restoredExitRecovery({
          awaitingRestoreSpawn: latest.awaitingRestoreSpawn === true,
          sessionOpen: sessionOpen && !latest.endedAt,
          keepShell: shouldKeepShellAfterExit(latest),
        })
        if (recovery === 'reattach') {
          useTerminalStore.setState(s => ({
            terminals: s.terminals.map(tab =>
              tab.id === terminalId && tab.status === 'exited'
                ? { ...tab, status: 'running', exitCode: null }
                : tab
            ),
          }))
          return
        }
        const note =
          recovery === 'await-spawn'
            ? pendingRestoreNote
            : translate('会话输出已恢复；可从终端标签重启进程')
        term.writeln(`\r\n\x1b[90m[${note}]\x1b[0m`)
        if (recovery === 'locked') writeFinishedTaskHint(term)
      })()
    }, 0)

    const ro = new ResizeObserver(() => {
      // 单窗格下未激活的标签只是 invisible，仍有真实尺寸：同样跟随布局 fit，
      // 让后台 TUI 提前按新网格重排，切回来时就不会先显示一帧旧网格画面。
      // 隐藏（display:none）的标签宽高为 0，fitNow 会自动跳过。
      // 【终端防闪烁关键逻辑，请勿移除】拖动期间严禁在 ResizeObserver/rAF 中
      // 调用 fit/term.resize。WebGL canvas 会立刻清空，而内容下一帧才重绘，
      // WebView2 因此会显示空白帧。拖动的最终网格只能由下面的 settle 提交。
      if (isPanelResizing()) return
      scheduleFit()
      // 从隐藏变为可见（如多窗格切换）时，被回收的 WebGL 在这里重新申请。
      if (isTerminalVisible()) ensureWebgl()
    })
    if (containerRef.current) ro.observe(containerRef.current)

    const onPanelResizeBegin = () => {
      if (isActiveRef.current) term.options.cursorBlink = false
    }
    const onPanelResizeSettle = (event: Event) => {
      if (!isActiveRef.current) {
        // 不可见的标签无需等待 WebGL 换帧屏障，直接按最终尺寸 fit。
        scheduleFit()
        return
      }
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
      webglCancelled = true
      ensureWebglRef.current = () => {}
      // addon 随 term.dispose() 一起释放，这里只归还预算槽位。
      releaseTerminalWebglSlot(webglSlotKey)
      window.clearTimeout(subscribeTimer)
      for (const id of fitTimers) window.clearTimeout(id)
      if (fitRafRef.current !== 0) {
        window.cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = 0
      }
      clearPtyResizeTimer()
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current)
        revealTimerRef.current = null
      }
      pendingPtySizeRef.current = null
      unsubscribeOutput?.()
      writeFlow.dispose()
      disposeOscHandlers()
      container.removeEventListener('wheel', onZoomWheel, { capture: true })
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
      disposeSelectionMenuGuard()
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      term.dispose()
      container.replaceChildren()
      xtermRef.current = null
      searchAddonRef.current = null
      setTerminalViewGrid(terminalId, null)
    }
  }, [
    clearBuffer,
    clearPtyResizeTimer,
    copySelection,
    contextMenuItems,
    fitSettledPanelGrid,
    flushPendingPtyResize,
    insertTerminalNewline,
    isTerminalWritable,
    openSearch,
    pasteFromClipboard,
    resizeGridFromContainer,
    resizeTerminal,
    scheduleFit,
    schedulePtyResize,
    setReplayMasked,
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
    ensureWebglRef.current()
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
    const onReset = (event: Event) => {
      const detail = (event as CustomEvent<TerminalViewBridgeDetail>).detail
      if (!matches(detail)) return
      resetTerminalView()
    }
    window.addEventListener(TERMINAL_CLEAR_EVENT, onClear)
    window.addEventListener(TERMINAL_SEARCH_EVENT, onSearch)
    window.addEventListener(TERMINAL_RESET_EVENT, onReset)
    return () => {
      window.removeEventListener(TERMINAL_CLEAR_EVENT, onClear)
      window.removeEventListener(TERMINAL_SEARCH_EVENT, onSearch)
      window.removeEventListener(TERMINAL_RESET_EVENT, onReset)
    }
  }, [clearBuffer, openSearch, resetTerminalView, terminalId])

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
      const notice = terminalRestoreNotices(terminal).starting
      // Reconnection keeps both the process and screen; only a new PTY is a restart.
      if (notice) {
        if (terminal.restorePreservedOutput) {
          term.writeln(`\x1b[90m\r\n── ${translate(notice)} ──\x1b[0m`)
        } else {
          term.reset()
          term.writeln(`\x1b[90m${translate(notice)}\x1b[0m`)
        }
      }
    } else if (terminal.status === 'exited' && previous !== 'exited') {
      const exited = terminal
      void (async () => {
        let sessionOpen: boolean | null = null
        try {
          sessionOpen = await terminalSessionOpen(terminalId)
        } catch {
          sessionOpen = null
        }
        if (xtermRef.current !== term) return
        const latest = useTerminalStore.getState().terminals.find(tab => tab.id === terminalId)
        if (!latest || latest.status !== 'exited') return
        // 断线说明已由 store 写入输出，不再追加“进程未启动”。
        if (!sessionOpen && consumeTerminalDisconnectNotice(terminalId)) return
        if (sessionOpen && !latest.endedAt) {
          useTerminalStore.setState(state => ({
            terminals: state.terminals.map(tab =>
              tab.id === terminalId && tab.status === 'exited'
                ? { ...tab, status: 'running', exitCode: null }
                : tab
            ),
          }))
          return
        }
        if (exited.exitCode === null) {
          term.writeln(
            `\r\n\x1b[90m[${translate('进程未启动')}${translate('，可从终端标签重启')}]\x1b[0m`
          )
        } else if (!shouldKeepShellAfterExit(exited)) {
          term.writeln(
            `\r\n\x1b[90m── ${translate('运行配置任务已结束（退出码 {code}）', {
              code: String(exited.exitCode),
            })} ──\x1b[0m`
          )
          writeFinishedTaskHint(term)
        } else {
          const detail = translate('进程已退出，退出码 {code}', { code: String(exited.exitCode) })
          term.writeln(`\r\n\x1b[90m[${detail}${translate('，可从终端标签重启')}]\x1b[0m`)
        }
      })()
    } else if (
      terminal.status === 'running' &&
      previous === 'starting' &&
      term.buffer.active.type === 'alternate'
    ) {
      // 接回在途期间视图要的重绘会被并进「补一次 resize」，而这次 resize 引起的 TUI 重绘
      // 可能赶在视图 fit 回自身网格之前、按快照网格解析成残缺画面。接回完成后由视图在
      // 网格就绪时（flushPendingRedraw 会等快照解析完）再整屏重绘一次。
      redrawPendingRef.current = true
      scheduleFit(true, false)
    }
    previousStatusRef.current = terminal.status
  }, [scheduleFit, terminal, terminalId])

  useEffect(() => {
    if (!composerOpen) return
    // 终端可能经 portal 挪进隐藏槽位或被 visibility 隐藏，没有统一事件可听，打开期间轻量轮询。
    const check = () => {
      const host = containerRef.current
      const visible =
        !!host &&
        host.isConnected &&
        host.offsetWidth > 0 &&
        host.offsetHeight > 0 &&
        (host.checkVisibility?.({ visibilityProperty: true }) ?? true)
      setComposerHidden(!visible)
    }
    check()
    const timer = window.setInterval(check, 300)
    return () => window.clearInterval(timer)
  }, [composerOpen])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void getCurrentWebview()
      .onDragDropEvent(event => {
        if (event.payload.type !== 'drop' || !isTerminalWritable()) return
        const tab = useTerminalStore.getState().terminals.find(item => item.id === terminalId)
        if (!tab || (isSshResource(tab.cwd) && !getTerminalSshUploadOnPaste())) return
        const point = logicalDropPoint(event.payload.position, window.devicePixelRatio)
        const host = document.elementFromPoint(point.x, point.y)?.closest(`[${TERMINAL_DROP_ATTR}]`)
        if (host?.getAttribute(TERMINAL_DROP_ATTR) !== terminalId) return
        const paths = event.payload.paths.filter(Boolean)
        if (paths.length === 0) return
        const term = xtermRef.current
        void prepareTerminalAttachments(tab, paths)
          .then(text => {
            if (
              text &&
              xtermRef.current === term &&
              isSameTerminalSession(
                tab,
                useTerminalStore.getState().terminals.find(item => item.id === terminalId)
              )
            )
              term?.paste(text)
          })
          .catch(error =>
            useProjectStore
              .getState()
              .pushToast('error', translate('粘贴失败：{error}', { error: String(error) }))
          )
      })
      .then(stop => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [isTerminalWritable, terminal?.cwd, terminalId])

  return (
    <div
      {...{ [TERMINAL_DROP_ATTR]: terminalId }}
      className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden box-border"
      onMouseDown={() => {
        if (isActive) xtermRef.current?.focus()
      }}
      onContextMenu={(event: ReactMouseEvent) => {
        if (deferToNativeContextMenuInDev()) return
        const term = xtermRef.current
        if (
          term &&
          !shouldUseTerminalContextMenu(term.hasSelection(), term.modes.mouseTrackingMode, event.shiftKey)
        ) {
          // Prevent browser chrome while leaving the TUI's mouse press/release untouched.
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (!shouldShowAppContextMenu(event)) return
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          items: contextMenuItems(
            xtermRef.current?.getSelection() ?? '',
            xtermRef.current ? terminalContent(xtermRef.current, 'screen') : ''
          ),
        })
      }}
    >
      {/* 底边不再留 8px：它会和排不满一整行的余量叠在一起，看起来像空了一行。 */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden px-2.5 pt-2">
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
        <TerminalConnectionNotice terminalId={terminalId} offsetForSearch={searchOpen} />
      </div>
      {terminal?.status === 'exited' && !terminal.awaitingRestoreSpawn && !terminal.ptySpawnPending && (
        <TerminalExitNotice
          exitCode={terminal.exitCode}
          restoreUnavailable={terminal.restoreUnavailable}
          onReopen={() => useTerminalStore.getState().reopenTerminalShell(terminalId)}
          onExport={async () => {
            const root = useProjectStore.getState().projects.find(project => project.id === terminal.projectId)?.path
            try { await exportTerminalDiagnostics(terminal, root) }
            catch (error) { useProjectStore.getState().pushToast('error', String(error)) }
          }}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {composerOpen && terminal && (
        <TerminalComposer
          terminalId={terminalId}
          terminalName={terminal.name}
          hidden={composerHidden}
          onClose={() => {
            setComposerOpen(false)
            if (isActiveRef.current) xtermRef.current?.focus()
          }}
          onFill={text => {
            const term = xtermRef.current
            if (
              !term ||
              !isTerminalWritable() ||
              (/\r|\n/.test(text) && !term.modes.bracketedPasteMode)
            )
              return false
            term.paste(text)
            return true
          }}
          prepareClipboard={async event => {
            const paths = await terminalClipboardPaths(event)
            return prepareAttachmentPaths(paths)
          }}
          prepareFiles={async files => {
            const paths = await storeAttachmentFiles(files)
            return prepareAttachmentPaths(paths)
          }}
          prepareFilePaths={prepareAttachmentPaths}
        />
      )}
    </div>
  )
}
