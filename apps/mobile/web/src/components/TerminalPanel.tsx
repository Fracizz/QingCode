import { t } from '@qn/codex-client'
import { ArrowDownToLine, ArrowUp, BookOpen, Check, ChevronDown, ChevronUp, ClipboardPaste, Copy, Ellipsis, Keyboard, Minus, Pencil, Plus, Search, Terminal as TerminalIcon, Type, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import type { TermAttachResult, TermExitInfo, TermInfo, TermOpenResult, TermOutputChunk } from '@qn/protocol'
import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react'
import { callDevice, getGateway } from '../client'
import { getWindowNativePort } from '../native'
import { projectRpc } from '../projectApi'
import { errorCode, friendlyError } from '../state'
import { useApp } from '../store'
import { subscribeTerminalEvents } from '../terminalEvents'
import { MAX_TERMINAL_FONT, MIN_TERMINAL_FONT, readTerminalFont, readTerminalPreferences, readTerminalQuickKeys, saveTerminalFont, saveTerminalPreferences, saveTerminalQuickKeys } from '../terminalPreferences'
import { decodeTerminalOutput, encodeTerminalInput, planMobileTerminalReplay } from '../terminalReplay'
import type { Project } from '../types'
import { registerBackHandler } from '../workspace'
import { Button, Dialog, Loading, LoadingIcon, Note, SheetAction } from './ui'
import { toast } from '../toast'

const quickKeys = () => [
  ['Esc', '\x1b', 'Esc'], ['Tab', '\t', 'Tab'], ['^C', '\x03', 'Ctrl+C'], ['⇧Tab', '\x1b[Z', 'Shift+Tab'],
  ['↑', '\x1b[A', t('上方向键')], ['↓', '\x1b[B', t('下方向键')], ['⌫', '\x7f', t('退格')],
  ['←', '\x1b[D', t('左方向键')], ['→', '\x1b[C', t('右方向键')],
] as const
const extraKeys = [
  ['Enter', '\r'], ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
  ['Ctrl+D', '\x04'], ['Ctrl+L', '\x0c'], ['Ctrl+U', '\x15'], ['Ctrl+Z', '\x1a'], ['Shift+←', '\x1b[1;2D'],
] as const
const encoder = new TextEncoder()
const MAX_INPUT = 128 * 1024
const MAX_PENDING = 1_024

type TerminalStatus = {
  attaching: boolean
  writable: boolean
  historyLost: boolean
  exit?: TermExitInfo
  error: string | null
}

type TerminalControls = {
  focus: () => void
  copy: () => Promise<void>
  paste: () => Promise<void>
  search: (query: string, backwards?: boolean) => boolean
  readText: () => string
  write: (text: string) => Promise<boolean>
  sendKey: (value: string) => void
  setFont: (size: number) => void
  scrollToBottom: () => void
  attach: () => void
  online: (connected: boolean) => void
}

function terminalTheme(host: HTMLElement) {
  const { backgroundColor, color, caretColor } = getComputedStyle(host)
  // xterm 使用实际色值绘制，避免画布与手机版主题的颜色脱节。
  return { background: backgroundColor, foreground: color, cursor: caretColor, cursorAccent: backgroundColor, selectionBackground: caretColor }
}

function mountTerminal(
  host: HTMLDivElement,
  desktopId: string,
  project: Project,
  info: TermInfo,
  onStatus: (status: TerminalStatus) => void,
  onScrolledUp: (scrolledUp: boolean) => void,
) {
  const terminal = new Terminal({
    cols: info.cols,
    rows: info.rows,
    cursorBlink: true,
    disableStdin: true,
    allowProposedApi: true,
    fontSize: readTerminalFont(),
    fontFamily: 'ui-monospace, Consolas, monospace',
    scrollback: 2500,
    minimumContrastRatio: 4.5,
    theme: terminalTheme(host),
    linkHandler: {
      activate: (event, uri) => {
        if (!/^https?:\/\//i.test(uri)) return
        event.preventDefault()
        window.open(uri, '_blank', 'noopener,noreferrer')
      },
    },
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  terminal.open(host)
  const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme(host) })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  const { termId } = info
  let status: TerminalStatus = { attaching: false, writable: false, historyLost: false, exit: info.exit, error: null }
  let online = false
  let disposed = false
  let generation = 0
  let pending: TermOutputChunk[] | null = null
  let overflow = false
  let lastSeq = 0
  let dimensions = { cols: info.cols, rows: info.rows }
  let pendingDimensions: typeof dimensions | undefined
  let drawingSnapshot = false
  let inputQueue: Promise<unknown> = Promise.resolve()
  let fitTimer: ReturnType<typeof setTimeout> | undefined

  const update = (patch: Partial<TerminalStatus>) => {
    if (disposed) return
    status = { ...status, ...patch }
    terminal.options.disableStdin = !status.writable
    onStatus(status)
  }
  const rpc = <T,>(method: 'attach' | 'write' | 'resize' | 'detach', params: Record<string, unknown> = {}) =>
    projectRpc<T>(project, `mobile.term.${method}`, { termId, ...params }, desktopId)
  const hasCurrentGeneration = (id: number) => !disposed && online && id === generation

  const applyDimensions = (size: { cols: number; rows: number }) => {
    if (size.cols !== terminal.cols || size.rows !== terminal.rows) terminal.resize(size.cols, size.rows)
  }
  const scheduleFit = () => {
    clearTimeout(fitTimer)
    if (!status.writable || !info.supportsResize) return
    fitTimer = setTimeout(() => {
      const next = fit.proposeDimensions()
      if (!next || next.cols < 1 || next.rows < 1 || (next.cols === dimensions.cols && next.rows === dimensions.rows)) return
      const current = generation
      void rpc<{ cols: number; rows: number }>('resize', { cols: next.cols, rows: next.rows }).then((result) => {
        if (!hasCurrentGeneration(current)) return
        dimensions = { cols: result.cols, rows: result.rows }
        applyDimensions(dimensions)
      }).catch((error: unknown) => {
        if (hasCurrentGeneration(current)) update({ error: friendlyError(error, t('调整终端尺寸失败')) })
      })
    }, 100)
  }
  const output = (chunk: TermOutputChunk) => {
    terminal.write(decodeTerminalOutput(chunk.data))
    lastSeq = chunk.seq
  }
  const write = (bytes: Uint8Array): Promise<boolean> => {
    if (!status.writable || !bytes.length) return Promise.resolve(false)
    if (bytes.length > MAX_INPUT) {
      update({ error: t('单次终端输入最多 128 KiB。') })
      return Promise.resolve(false)
    }
    const current = generation
    const transfer = inputQueue.then(async () => {
      if (!hasCurrentGeneration(current) || !status.writable) return false
      const result = await rpc<{ acceptedBytes: number }>('write', { data: encodeTerminalInput(bytes) })
      if (result.acceptedBytes !== bytes.length) throw new Error(t('目标只接收了部分输入'))
      return hasCurrentGeneration(current)
    }).catch((error: unknown) => {
      if (hasCurrentGeneration(current)) update({ error: friendlyError(error, t('无法发送终端输入')) })
      return false
    })
    inputQueue = transfer
    return transfer
  }

  function attach() {
    if (!online || disposed || status.attaching) return
    const current = ++generation
    const sinceSeq = lastSeq
    pending = []
    pendingDimensions = undefined
    drawingSnapshot = false
    overflow = false
    update({ attaching: true, writable: false, error: null })
    void rpc<TermAttachResult>('attach', { sinceSeq }).then((result) => {
      if (!hasCurrentGeneration(current)) return
      const replay = planMobileTerminalReplay(sinceSeq, result, pending ?? [])
      pending = null
      lastSeq = replay.baseSeq
      if (replay.reset) terminal.reset()
      dimensions = pendingDimensions ?? { cols: result.cols, rows: result.rows }
      if (replay.snapshot) {
        drawingSnapshot = true
        applyDimensions(replay.snapshot)
        terminal.write(decodeTerminalOutput(replay.snapshot.data), () => {
          if (hasCurrentGeneration(current)) {
            drawingSnapshot = false
            applyDimensions(dimensions)
          }
        })
      } else {
        applyDimensions(dimensions)
      }
      for (const chunk of replay.chunks) output(chunk)
      const missing = overflow || replay.gap
      const exit = status.exit ?? result.exit
      update({
        attaching: false, exit, writable: result.alive && !exit && !missing,
        historyLost: status.historyLost || replay.historyLost,
        error: missing ? t('终端输出出现缺口，请重试接回。') : status.error,
      })
      scheduleFit()
    }).catch((error: unknown) => {
      if (!hasCurrentGeneration(current)) return
      pending = null
      update({ attaching: false, writable: false, error: friendlyError(error, t('无法接回终端')) })
    })
  }

  const unsubscribe = subscribeTerminalEvents(desktopId, (event) => {
    if (!online || event.targetId !== project.targetId || event.projectId !== project.id
      || !event.payload || typeof event.payload !== 'object') return
    const payload = event.payload as Record<string, unknown>
    if (payload.termId !== termId) return
    if (event.name === 'term.data') {
      const { data, seq } = payload
      if (typeof data !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= lastSeq) return
      const chunk = { data, seq }
      if (pending) {
        if (pending.length < MAX_PENDING) pending.push(chunk)
        else overflow = true
      } else if (chunk.seq === lastSeq + 1) {
        try {
          output(chunk)
        } catch {
          update({ error: t('终端输出无法读取，请重试接回。'), writable: false })
        }
      } else {
        attach()
      }
    } else if (event.name === 'term.exit') {
      update({
        exit: {
          code: typeof payload.code === 'number' ? payload.code : null,
          signal: typeof payload.signal === 'string' ? payload.signal : null,
        },
        writable: false,
      })
    } else if (event.name === 'term.resized' && typeof payload.cols === 'number' && typeof payload.rows === 'number') {
      dimensions = { cols: payload.cols, rows: payload.rows }
      if (pending) pendingDimensions = dimensions
      else if (!drawingSnapshot) applyDimensions(dimensions)
    } else if (event.name === 'term.error' && typeof payload.message === 'string') {
      update({ error: payload.message })
    }
  })
  const keyboard = terminal.onData((text) => void write(encoder.encode(text)))
  const binary = terminal.onBinary((text) => void write(Uint8Array.from(text, (character) => character.charCodeAt(0))))
  const updateScroll = () => {
    const { baseY, viewportY } = terminal.buffer.active
    onScrolledUp(viewportY < baseY)
  }
  const scroll = terminal.onScroll(updateScroll)
  const parsed = terminal.onWriteParsed(updateScroll)
  const observer = new ResizeObserver(scheduleFit)
  observer.observe(host)

  const api: TerminalControls = {
    focus: () => terminal.focus(),
    copy: async () => {
      const text = terminal.getSelection() || window.getSelection()?.toString()
      if (!text) return
      if (getWindowNativePort()) await callDevice('clipboard.write', { text })
      else await navigator.clipboard.writeText(text)
    },
    paste: async () => {
      if (!status.writable) return
      const text = await getGateway().readClipboard()
      if (!disposed) terminal.paste(text)
    },
    search: (query, backwards = false) => {
      if (!query) { search.clearDecorations(); return true }
      return backwards ? search.findPrevious(query) : search.findNext(query)
    },
    readText: () => {
      const buffer = terminal.buffer.active
      const start = Math.max(0, buffer.length - 600)
      const lines: string[] = []
      for (let index = start; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
      return lines.join('\n').trimEnd()
    },
    write: (text) => write(encoder.encode(text)),
    sendKey: (value) => {
      // 全屏程序可切到应用光标模式，快捷键与实体键盘发送相同序列。
      const data = terminal.modes.applicationCursorKeysMode && /^\x1b\[[A-DFH]$/.test(value)
        ? `\x1bO${value.at(-1)}` : value
      void write(encoder.encode(data))
    },
    setFont: (size) => {
      terminal.options.fontSize = size
      scheduleFit()
    },
    scrollToBottom: () => terminal.scrollToBottom(),
    attach,
    online: (connected) => {
      if (online === connected) return
      online = connected
      if (connected) attach()
      else {
        ++generation
        pending = null
        update({ attaching: false, writable: false })
      }
    },
  }
  const dispose = () => {
    disposed = true
    ++generation
    unsubscribe()
    observer.disconnect()
    themeObserver.disconnect()
    clearTimeout(fitTimer)
    keyboard.dispose()
    binary.dispose()
    scroll.dispose()
    parsed.dispose()
    terminal.dispose()
    void rpc('detach').catch(() => undefined)
  }
  return { api, dispose }
}

function TerminalScreen({ desktopId, project, info, menu, onCloseMenu, onCloseTerminal, onRename, onExit, busy, draft, setDraft }: {
  desktopId: string
  project: Project
  info: TermInfo
  menu: boolean
  onCloseMenu: () => void
  onCloseTerminal: () => void
  onRename: () => void
  onExit: (termId: string, exit: TermExitInfo) => void
  busy: boolean
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
}) {
  const host = useRef<HTMLDivElement>(null)
  const projectRef = useRef(project)
  const infoRef = useRef(info)
  const controls = useRef<TerminalControls | null>(null)
  const connected = useApp((s) => s.eventsConnected)
  const targetState = useApp((s) => s.targetStates[project.targetId]?.state)
  const requestConnect = useApp((s) => s.requestConnect)
  const ready = connected && (targetState === undefined || targetState === 'ready')
  const [status, setStatus] = useState<TerminalStatus>({ attaching: false, writable: false, historyLost: false, exit: info.exit, error: null })
  const [font, setFont] = useState(readTerminalFont)
  const [extra, setExtra] = useState<'keys' | 'font' | 'keySettings' | null>(null)
  const [preferredKeys, setPreferredKeys] = useState(() => readTerminalQuickKeys() ?? quickKeys().map(([name]) => name))
  const [scrolledUp, setScrolledUp] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(true)
  const [selectableText, setSelectableText] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    if (!host.current) return
    const mounted = mountTerminal(host.current, desktopId, projectRef.current, infoRef.current, setStatus, setScrolledUp)
    controls.current = mounted.api
    return () => { controls.current = null; mounted.dispose() }
  }, [desktopId])
  useEffect(() => controls.current?.online(ready), [ready])
  useEffect(() => {
    if (status.exit) onExit(info.termId, status.exit)
  }, [info.termId, onExit, status.exit])
  useEffect(() => {
    if (!searchOpen) return
    return registerBackHandler(() => {
      controls.current?.search('')
      setQuery('')
      setSearchOpen(false)
    })
  }, [searchOpen])

  const submit = async () => {
    if (writing || !status.writable) return
    setWriting(true)
    const text = draft
    const accepted = await controls.current?.write(text + '\r')
    if (accepted) setDraft((current) => current === text ? '' : current)
    setWriting(false)
  }
  const paste = () => {
    void controls.current?.paste().catch((error: unknown) => toast(friendlyError(error, t('无法粘贴剪贴板')), { tone: 'error' }))
  }
  const copy = () => {
    void controls.current?.copy().catch((error: unknown) => toast(friendlyError(error, t('无法复制选区')), { tone: 'error' }))
  }
  const sendWithKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }
  const find = (value: string, backwards = false) => setFound(controls.current?.search(value, backwards) ?? false)
  const changeFont = (size: number) => {
    setFont(size)
    saveTerminalFont(size)
    controls.current?.setFont(size)
  }
  const changeKeys = (keys: string[]) => {
    setPreferredKeys(keys)
    saveTerminalQuickKeys(keys)
  }
  const keys = [...quickKeys(), ...extraKeys]

  return (
    <>
      {connected && !ready && (
        <Note message={t('目标连接已中断。')} tone="warn"
          actionLabel={targetState !== 'connecting' && targetState !== 'deploying' ? t('连接目标') : undefined}
          onAction={() => requestConnect(project.targetId)} />
      )}
      {status.attaching && <Loading text={t('正在接回终端…')} />}
      {status.exit && <Note message={`${t('终端已退出')}${status.exit.signal ? ` · ${status.exit.signal}`
        : status.exit.code !== null ? ` · ${t('退出码 {code}', { code: status.exit.code })}` : ''}`} />}
      {status.historyLost && <p className="text-xs text-qn-warn">{t('部分历史超出目标的输出缓冲，已显示剩余记录。')}</p>}
      {status.error && <Note message={status.error} tone="error" actionLabel={ready ? t('重试接回') : undefined}
        onAction={() => controls.current?.attach()} />}

      {menu && <Dialog title={t('终端操作')} onClose={onCloseMenu}>
        <div className="qn-sheet-actions">
          <SheetAction icon={Pencil} onClick={onRename}>{t('重命名终端')}</SheetAction>
          <SheetAction icon={ClipboardPaste} disabled={!status.writable} onClick={() => { onCloseMenu(); paste() }}>{t('粘贴到终端')}</SheetAction>
          <SheetAction icon={Copy} onClick={() => { onCloseMenu(); copy() }}>{t('复制选区')}</SheetAction>
          <SheetAction icon={Search} onClick={() => { onCloseMenu(); setSearchOpen(true) }}>{t('搜索输出')}</SheetAction>
          <SheetAction icon={BookOpen} onClick={() => { onCloseMenu(); setSelectableText(controls.current?.readText() ?? '') }}>{t('阅读输出')}</SheetAction>
          <SheetAction icon={Type} onClick={() => { onCloseMenu(); setExtra('font') }}>{t('终端字号')}</SheetAction>
          <SheetAction icon={Keyboard} onClick={() => { onCloseMenu(); setExtra('keySettings') }}>{t('设置常用快捷键')}</SheetAction>
          <SheetAction icon={X} danger disabled={!connected || busy} onClick={onCloseTerminal}>{t('关闭终端')}</SheetAction>
        </div>
      </Dialog>}
      {searchOpen && (
        <div>
          <div className="flex items-center gap-1">
            <input className="qn-input min-w-0 flex-1" type="search" aria-label={t('搜索终端输出')} value={query}
              onChange={(event) => { setQuery(event.target.value); find(event.target.value) }} />
            <div className="qn-header-island">
              <Button variant="ghost" className="qn-header-icon size-[44px]" aria-label={t('上一个匹配')} disabled={!query} onClick={() => find(query, true)}><ChevronUp size={18} aria-hidden /></Button>
              <Button variant="ghost" className="qn-header-icon size-[44px]" aria-label={t('下一个匹配')} disabled={!query} onClick={() => find(query)}><ChevronDown size={18} aria-hidden /></Button>
              <Button variant="ghost" className="qn-header-icon size-[44px]" aria-label={t('关闭')} onClick={() => { setQuery(''); find(''); setSearchOpen(false) }}><X size={18} aria-hidden /></Button>
            </div>
          </div>
          {query && !found && <p role="status" className="mt-1 text-xs text-qn-muted">{t('无匹配')}</p>}
        </div>
      )}
      <div className="qn-terminal-surface">
        <div ref={host} className="qn-terminal-host" aria-label={t('终端输出')} />
        {scrolledUp && <Button className="qn-terminal-follow size-[44px]" aria-label={t('回到最新输出')}
          onClick={() => controls.current?.scrollToBottom()}><ArrowDownToLine size={18} aria-hidden /></Button>}
      </div>
      {selectableText !== null && <Dialog title={t('阅读终端输出')} placement="full" className="qn-terminal-page" onClose={() => setSelectableText(null)}>
        <pre className="qn-terminal-readable" tabIndex={0}>{selectableText || t('暂无终端输出')}</pre>
      </Dialog>}
      <footer className="qn-terminal-footer">
        <div className="qn-terminal-keys" role="group" aria-label={t('终端快捷键')}>
          <div className="qn-terminal-quick-keys">
            {keys.filter(([name]) => preferredKeys.includes(name)).map(([name, value, label = name]) => (
              <Button key={name} aria-label={t('发送 {key}', { key: label })} onMouseDown={(event) => event.preventDefault()}
                onClick={() => controls.current?.sendKey(value)} disabled={!status.writable}>{name}</Button>
            ))}
          </div>
          <Button className="qn-terminal-more" aria-label={t('更多终端快捷键')} aria-haspopup="dialog" disabled={!status.writable}
            onClick={() => setExtra('keys')}><Ellipsis size={20} aria-hidden /></Button>
        </div>
        <div className="qn-terminal-composer">
          <Button className="qn-terminal-keyboard size-[44px]" aria-label={t('终端键盘')} disabled={!status.writable} onClick={() => controls.current?.focus()}>
            <Keyboard size={20} strokeWidth={1.75} aria-hidden />
          </Button>
          <textarea className="qn-textarea min-w-0 flex-1" rows={1} aria-label={t('终端草稿')} value={draft}
            onChange={(event) => setDraft(event.target.value)} onKeyDown={sendWithKeyboard} placeholder={t('输入命令后发送')} />
          <Button variant="primary" className="qn-send-button" aria-label={writing ? t('发送中') : t('发送命令')} aria-busy={writing}
            onClick={() => void submit()} disabled={!status.writable || writing}>
            {writing ? <LoadingIcon size={16} /> : <ArrowUp size={18} strokeWidth={2.5} aria-hidden />}
          </Button>
        </div>
      </footer>
      {extra === 'keys' && <Dialog title={t('更多终端快捷键')} onClose={() => setExtra(null)}>
        <div className="qn-terminal-extra-keys">
          {keys.map(([name, value, label = name]) => (
            <Button key={name} aria-label={t('发送 {key}', { key: label })} disabled={!status.writable}
              onClick={() => { controls.current?.sendKey(value); setExtra(null) }}>{name}</Button>
          ))}
        </div>
      </Dialog>}
      {extra === 'font' && <Dialog title={t('终端字号')} onClose={() => setExtra(null)}>
        <div className="flex items-center justify-center gap-4">
          <Button className="size-[44px]" aria-label={t('缩小终端字号')} disabled={font <= MIN_TERMINAL_FONT} onClick={() => changeFont(font - 1)}>
            <Minus size={18} aria-hidden />
          </Button>
          <output className="min-w-16 text-center tabular-nums" aria-label={t('终端字号')}>{font} px</output>
          <Button className="size-[44px]" aria-label={t('放大终端字号')} disabled={font >= MAX_TERMINAL_FONT} onClick={() => changeFont(font + 1)}>
            <Plus size={18} aria-hidden />
          </Button>
        </div>
      </Dialog>}
      {extra === 'keySettings' && <Dialog title={t('设置常用快捷键')} onClose={() => setExtra(null)}>
        <div className="grid grid-cols-2 gap-1">
          {keys.map(([name, , label = name]) => (
            <label key={name} className="flex min-h-[44px] items-center gap-2 px-2 text-sm">
              <input className="size-4 accent-qn-accent" type="checkbox" checked={preferredKeys.includes(name)}
                aria-label={label} onChange={(event) => changeKeys(event.target.checked
                  ? [...preferredKeys, name] : preferredKeys.filter((key) => key !== name))} />
              {name}
            </label>
          ))}
        </div>
        <Button className="mt-2" onClick={() => changeKeys(quickKeys().map(([name]) => name))}>{t('恢复默认快捷键')}</Button>
      </Dialog>}
    </>
  )
}

export function TerminalPanel({ project }: { project: Project }) {
  const desktopId = useApp((s) => s.activeId)
  const connected = useApp((s) => s.eventsConnected)
  const connectionWarning = useApp((s) => s.eventsError)
  const targetState = useApp((s) => s.targetStates[project.targetId]?.state)
  const preferenceKey = `qn.mobile.terminals:${JSON.stringify([desktopId, project.targetId, project.id, project.path])}`
  const [preferences] = useState(() => readTerminalPreferences(preferenceKey))
  const [list, setList] = useState<TermInfo[] | null>(null)
  const [termId, setTermId] = useState<string | null>(preferences.selectedId ?? null)
  const [names, setNames] = useState(preferences.names)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loadingList, setLoadingList] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; action: 'list' | 'open' | 'connect' | 'close' } | null>(null)
  const needsTarget = error?.action === 'connect'
  const requestConnect = useApp((s) => s.requestConnect)
  const [refresh, setRefresh] = useState(0)
  const [sheet, setSheet] = useState<'switch' | 'actions' | 'rename' | 'close' | null>(null)
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')

  useEffect(() => saveTerminalPreferences(preferenceKey, { selectedId: termId ?? undefined, names }), [preferenceKey, termId, names])

  const open = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const terminal = await projectRpc<TermOpenResult>(project, 'mobile.term.open', { cols: 80, rows: 20 }, desktopId)
      if (!terminal.termId) throw new Error(t('电脑返回了无效的终端信息'))
      setList((items) => [...(items ?? []).filter((item) => item.termId !== terminal.termId), terminal])
      setTermId(terminal.termId)
    } catch (error) {
      setError({ message: friendlyError(error, t('新建项目终端失败')), action: 'open' })
    } finally {
      setBusy(false)
    }
  }, [desktopId, project])

  useEffect(() => {
    if (!desktopId || !connected) return
    let current = true
    setLoadingList(true)
    void projectRpc<{ terminals: TermInfo[] }>(project, 'mobile.term.list', {}, desktopId).then((result) => {
      if (!current) return
      if (!Array.isArray(result?.terminals)) throw new Error(t('当前电脑版本不支持手机终端，请更新电脑端。'))
      setError(null)
      const terminals = [...result.terminals].sort((a, b) => a.startedAt - b.startedAt)
      setList(terminals)
      const defaultId = terminals.find((item) => item.alive)?.termId ?? terminals[0]?.termId ?? null
      setTermId((id) => terminals.some((item) => item.termId === id) ? id : defaultId)
    }).catch((error: unknown) => {
      if (!current) return
      const code = errorCode(error)
      const message = friendlyError(error, t('读取终端失败'))
      if (code === 'terminal_disabled') {
        setError({ message: t('请在电脑「设置 → 手机连接」中启用项目终端，然后重试。'), action: 'list' })
      } else if (code === 'method') {
        setError({ message: t('项目主机的服务版本不支持终端。请从电脑重新连接项目主机后重试。'), action: 'list' })
      } else if (code === 'forbidden' && (error instanceof Error && error.message.includes('网关白名单') || message === t('该方法不在手机网关白名单内'))) { // i18n-ignore: 子串用于匹配旧网关的固定错误文本。
        setError({ message: t('当前电脑版本不支持手机终端，请更新电脑端。'), action: 'list' })
      } else {
        setError({ message, action: code === 'not_connected' ? 'connect' : 'list' })
      }
      setList((existing) => existing ?? [])
    }).finally(() => {
      if (current) setLoadingList(false)
    })
    return () => { current = false }
  }, [desktopId, project, connected, targetState, refresh])

  const selectedIndex = list?.findIndex((item) => item.termId === termId) ?? -1
  const selected = list?.[selectedIndex]
  const label = (item: TermInfo, index: number) => names[item.termId] || t('终端 {index}', { index: index + 1 })
  const needle = search.trim().toLocaleLowerCase()
  const visibleTerms = (list ?? []).flatMap((item, index) => {
    const title = label(item, index)
    const shell = item.shell.split(/[\\/]/).at(-1) ?? item.shell
    return !needle || `${title} ${shell}`.toLocaleLowerCase().includes(needle) ? [{ item, title, shell }] : []
  })
  const canOpen = connected && !busy && !loadingList && list !== null && (!error || error.action === 'open' || error.action === 'close')

  const onExit = useCallback((id: string, exit: TermExitInfo) => {
    setList((items) => items?.map((item) => item.termId === id && item.alive ? { ...item, alive: false, exit } : item) ?? null)
  }, [])

  const terminate = async () => {
    if (!selected || busy) return
    setError(null)
    setBusy(true)
    try {
      await projectRpc(project, 'mobile.term.close', { termId: selected.termId }, desktopId)
      setList((items) => (items ?? []).filter((item) => item.termId !== selected.termId))
      setTermId(list?.find((item) => item.termId !== selected.termId && item.alive)?.termId
        ?? list?.find((item) => item.termId !== selected.termId)?.termId ?? null)
      const { [selected.termId]: _name, ...remainingNames } = names
      setNames(remainingNames)
      setDrafts(({ [selected.termId]: _draft, ...remaining }) => remaining)
      setSheet(null)
    } catch (error) {
      setError({ message: friendlyError(error, t('关闭终端失败')), action: 'close' })
    } finally {
      setBusy(false)
    }
  }

  const retry = () => {
    if (!connected || busy) return
    switch (error?.action) {
      case 'open':
        void open()
        return
      case 'list':
        setRefresh((attempt) => attempt + 1)
        return
      case 'connect':
        requestConnect(project.targetId)
    }
  }

  function saveName() {
    if (!selected || !name.trim()) return
    setNames((current) => ({ ...current, [selected.termId]: name.trim() }))
    setSheet(null)
  }

  function dismissClose() {
    if (busy) return
    setSheet(null)
    if (error?.action === 'close') setError(null)
  }

  return (
    <section className="qn-terminal-panel">
      <div className="qn-terminal-toolbar" role="group" aria-label={t('项目终端')}>
        {selected && <Button className="qn-terminal-picker" aria-label={t('切换终端')} aria-haspopup="dialog" aria-expanded={sheet === 'switch'}
          disabled={busy} onClick={() => { setSearch(''); setSheet('switch') }}>
          <TerminalIcon size={18} strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 truncate">{label(selected, selectedIndex)}{!selected.alive && t(' · 已退出')}</span>
          <ChevronDown size={16} aria-hidden />
        </Button>}
        <div className={selected ? 'qn-header-island' : undefined}>
          <Button variant={selected ? 'ghost' : 'primary'} className={selected ? 'qn-header-icon size-[44px]' : 'min-h-[44px] rounded-full'}
            aria-label={t('新建终端')} disabled={!canOpen}
            onClick={() => void open()}><Plus size={20} aria-hidden />{!selected && t('新建终端')}</Button>
          {selected && <Button variant="ghost" className="qn-header-icon size-[44px]" aria-label={t('终端操作')}
            aria-haspopup="dialog" aria-expanded={sheet === 'actions'} onClick={() => setSheet('actions')}><Ellipsis size={20} aria-hidden /></Button>}
        </div>
      </div>
      {sheet === 'switch' && selected && <Dialog title={t('切换终端')} onClose={() => setSheet(null)}>
        <div className="grid gap-2">
          {(list?.length ?? 0) > 1 && <input type="search" className="qn-input" value={search} aria-label={t('搜索终端会话')}
            placeholder={t('搜索终端会话')} onChange={(event) => setSearch(event.target.value)} />}
          {visibleTerms.map(({ item, title, shell }) => (
            <button key={item.termId} type="button" className="qn-row qn-surface gap-3 px-3 py-2" aria-pressed={item.termId === termId}
              disabled={busy} onClick={() => { setTermId(item.termId); setSheet(null) }}>
              <TerminalIcon size={18} strokeWidth={1.75} className="shrink-0 text-qn-muted" aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm">{title}</span>
                <span className="block truncate text-xs text-qn-muted">{shell}{!item.alive && t(' · 已退出')}</span>
              </span>
              {item.termId === termId && <Check size={18} className="shrink-0 text-qn-accent" aria-hidden />}
            </button>
          ))}
          {!visibleTerms.length && <p role="status" className="text-sm text-qn-muted">{t('无匹配')}</p>}
        </div>
      </Dialog>}
      {sheet === 'rename' && selected && <Dialog title={t('重命名终端')} onClose={() => setSheet(null)}>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); saveName() }}>
          <input className="qn-input" aria-label={t('终端名称')} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          <p className="text-xs text-qn-muted">{t('终端名称只保存在此手机。')}</p>
          <Button variant="primary" type="submit" disabled={!name.trim()}>{t('保存')}</Button>
        </form>
      </Dialog>}
      {sheet === 'close' && selected && <Dialog title={t('关闭终端')} onClose={dismissClose}>
        <p className="mb-3 text-sm text-qn-muted">{t('关闭会终止该终端。')}</p>
        {error?.action === 'close' && <Note message={error.message} tone="error" />}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={dismissClose}>{t('取消')}</Button>
          <Button variant="danger" disabled={busy || !connected} onClick={() => void terminate()}>{t('关闭')}</Button>
        </div>
      </Dialog>}
      {error && !(sheet === 'close' && error.action === 'close') && <Note message={error.message} tone="error" actionLabel={needsTarget ? t('连接目标') : t('重试')} onAction={retry} />}
      {list === null && connected && <Loading text={t('正在读取可接回的项目终端…')} />}
      {list !== null && !selected && busy && <Loading text={t('正在新建终端…')} />}
      {!connected && connectionWarning && <Note message={connectionWarning} tone="warn" />}
      {list?.length === 0 && !error && !busy && <p className="py-5 text-center text-sm text-qn-muted">{t('该项目还没有手机终端。')}</p>}
      {desktopId && selected && <TerminalScreen key={`${desktopId}:${selected.termId}`} desktopId={desktopId} project={project} info={selected}
        menu={sheet === 'actions'} busy={busy} onCloseMenu={() => setSheet(null)} onCloseTerminal={() => setSheet('close')}
        onRename={() => { setName(label(selected, selectedIndex)); setSheet('rename') }} onExit={onExit} draft={drafts[selected.termId] ?? ''}
        setDraft={(update) => setDrafts((current) => ({ ...current, [selected.termId]: typeof update === 'function' ? update(current[selected.termId] ?? '') : update }))} />}
    </section>
  )
}
