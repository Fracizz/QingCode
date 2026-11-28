import { t } from '@qn/codex-client'
import { ChevronDown, ChevronUp, Ellipsis, Keyboard, Plus, Send } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import type { TermAttachResult, TermExitInfo, TermInfo, TermOpenResult, TermOutputChunk } from '@qn/protocol'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { callDevice, getGateway } from '../client'
import { getWindowNativePort } from '../native'
import { projectRpc } from '../projectApi'
import { errorCode, friendlyError } from '../state'
import { useApp } from '../store'
import { subscribeTerminalEvents } from '../terminalEvents'
import { decodeTerminalOutput, encodeTerminalInput, planMobileTerminalReplay } from '../terminalReplay'
import type { Project } from '../types'
import { registerBackHandler } from '../workspace'
import { Button, Dialog, Loading, Note } from './ui'
import './terminal.css'
import { toast } from '../toast'

const controlKeys = [
  ['Esc', '\x1b', 'Esc'], ['Tab', '\t', 'Tab'], ['^C', '\x03', 'Ctrl+C'],
  ['⇧Tab', '\x1b[Z', 'Shift+Tab'], ['↑', '\x1b[A', t('上方向键')], ['↓', '\x1b[B', t('下方向键')],
  ['⌫', '\x7f', t('退格')], ['←', '\x1b[D', t('左方向键')], ['→', '\x1b[C', t('右方向键')],
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
  attach: () => void
  online: (connected: boolean) => void
}

function mountTerminal(
  host: HTMLDivElement,
  desktopId: string,
  project: Project,
  info: TermInfo,
  onStatus: (status: TerminalStatus) => void,
) {
  const terminal = new Terminal({
    cols: info.cols,
    rows: info.rows,
    cursorBlink: true,
    disableStdin: true,
    allowProposedApi: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, Consolas, monospace',
    scrollback: 2500,
    theme: { background: '#161816', foreground: '#f2f3f1', cursor: '#65ddc9' },
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
    clearTimeout(fitTimer)
    keyboard.dispose()
    binary.dispose()
    terminal.dispose()
    void rpc('detach').catch(() => undefined)
  }
  return { api, dispose }
}

function TerminalScreen({ desktopId, project, info, menu, onCloseMenu, onCloseTerminal, busy }: {
  desktopId: string
  project: Project
  info: TermInfo
  menu: boolean
  onCloseMenu: () => void
  onCloseTerminal: () => void
  busy: boolean
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
  const [draft, setDraft] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(true)
  const [selectableText, setSelectableText] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    if (!host.current) return
    const mounted = mountTerminal(host.current, desktopId, projectRef.current, infoRef.current, setStatus)
    controls.current = mounted.api
    return () => { controls.current = null; mounted.dispose() }
  }, [desktopId])
  useEffect(() => controls.current?.online(ready), [ready])
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
        <div className="grid gap-1">
          <Button variant="ghost" disabled={!status.writable} onClick={() => { onCloseMenu(); paste() }}>{t('粘贴到终端')}</Button>
          <Button variant="ghost" onClick={() => { onCloseMenu(); copy() }}>{t('复制选区')}</Button>
          <Button variant="ghost" onClick={() => { onCloseMenu(); setSearchOpen(true) }}>{t('搜索输出')}</Button>
          <Button variant="ghost" onClick={() => { onCloseMenu(); setSelectableText(controls.current?.readText() ?? '') }}>{t('阅读输出')}</Button>
          <Button variant="ghost" disabled={!connected || busy} onClick={onCloseTerminal}>{t('关闭终端')}</Button>
        </div>
      </Dialog>}
      {searchOpen && (
        <div className="flex items-center gap-2">
          <input className="qn-input min-w-0 flex-1" type="search" aria-label={t('搜索终端输出')} value={query}
            onChange={(event) => { setQuery(event.target.value); find(event.target.value) }} />
          <Button aria-label={t('上一个匹配')} disabled={!query} onClick={() => find(query, true)}><ChevronUp size={17} /></Button>
          <Button aria-label={t('下一个匹配')} disabled={!query} onClick={() => find(query)}><ChevronDown size={17} /></Button>
          <Button variant="ghost" onClick={() => { setQuery(''); find(''); setSearchOpen(false) }}>{t('关闭')}</Button>
          {query && !found && <span role="status" className="text-xs text-qn-muted">{t('无匹配')}</span>}
        </div>
      )}
      <div className="qn-terminal-surface">
        <div ref={host} className="qn-terminal-host" aria-label={t('终端输出')} />
      </div>
      {selectableText !== null && <Dialog title={t('阅读终端输出')} placement="full" onClose={() => setSelectableText(null)}>
        <pre className="qn-terminal-readable" tabIndex={0}>{selectableText || t('暂无终端输出')}</pre>
      </Dialog>}
      <div className="qn-terminal-tools qn-terminal-keys" aria-label={t('终端快捷键')}>
        {controlKeys.map(([name, value, label]) => (
          <Button key={name} aria-label={t('发送 {key}', { key: label })} onClick={() => void controls.current?.write(value)} disabled={!status.writable}>{name}</Button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <Button variant="ghost" aria-label={t('终端键盘')} disabled={!status.writable} onClick={() => controls.current?.focus()}>
          <Keyboard size={18} aria-hidden />
        </Button>
        <textarea className="qn-textarea min-w-0 flex-1" rows={1} aria-label={t('终端草稿')} value={draft}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={sendWithKeyboard} placeholder={t('输入命令后发送')} />
        <Button variant="primary" aria-label={writing ? t('发送中') : t('发送命令')} onClick={() => void submit()} disabled={!status.writable || writing}>
          <Send size={17} aria-hidden />
        </Button>
      </div>
    </>
  )
}

export function TerminalPanel({ project }: { project: Project }) {
  const desktopId = useApp((s) => s.activeId)
  const connected = useApp((s) => s.eventsConnected)
  const connectionWarning = useApp((s) => s.eventsError)
  const targetState = useApp((s) => s.targetStates[project.targetId]?.state)
  const [list, setList] = useState<TermInfo[] | null>(null)
  const [termId, setTermId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsTarget, setNeedsTarget] = useState(false)
  const requestConnect = useApp((s) => s.requestConnect)
  const [refresh, setRefresh] = useState(0)
  const [closing, setClosing] = useState(false)
  const [menu, setMenu] = useState(false)
  const openOnEntry = useRef(true)

  const open = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const terminal = await projectRpc<TermOpenResult>(project, 'mobile.term.open', { cols: 80, rows: 20 }, desktopId)
      if (!terminal.termId) throw new Error(t('电脑返回了无效的终端信息'))
      setList((items) => [...(items ?? []).filter((item) => item.termId !== terminal.termId), terminal])
      setTermId(terminal.termId)
      return true
    } catch (error) {
      setError(friendlyError(error, t('新建项目终端失败')))
      return false
    } finally {
      setBusy(false)
    }
  }, [desktopId, project])

  useEffect(() => {
    if (!desktopId || !connected) return
    let current = true
    void projectRpc<{ terminals: TermInfo[] }>(project, 'mobile.term.list', {}, desktopId).then((result) => {
      if (!current) return
      if (!Array.isArray(result?.terminals)) throw new Error(t('电脑未提供手机终端，请检查桌面版设置。'))
      setError(null)
      setNeedsTarget(false)
      const terminals = [...result.terminals].sort((a, b) => a.startedAt - b.startedAt)
      setList(terminals)
      const defaultId = terminals.find((item) => item.alive)?.termId ?? terminals[0]?.termId ?? null
      if (openOnEntry.current) {
        openOnEntry.current = false
        void open().then((created) => {
          if (!created && current) setTermId((id) => id ?? defaultId)
        })
        return
      }
      setTermId((id) => terminals.find((item) => item.termId === id)?.termId
        ?? defaultId)
    }).catch((error: unknown) => {
      if (!current) return
      setError(friendlyError(error, t('读取终端失败')))
      setNeedsTarget(errorCode(error) === 'not_connected')
      setList((existing) => existing ?? [])
    })
    return () => { current = false }
  }, [desktopId, project, connected, targetState, refresh, open])

  const selected = list?.find((item) => item.termId === termId)

  const terminate = async () => {
    if (!selected || busy) return
    setError(null)
    setBusy(true)
    try {
      await projectRpc(project, 'mobile.term.close', { termId: selected.termId }, desktopId)
      setList((items) => (items ?? []).filter((item) => item.termId !== selected.termId))
      setTermId(list?.find((item) => item.termId !== selected.termId && item.alive)?.termId
        ?? list?.find((item) => item.termId !== selected.termId)?.termId ?? null)
      setClosing(false)
    } catch (error) {
      setError(friendlyError(error, t('关闭终端失败')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="qn-terminal-panel">
      <div className="flex items-center gap-1" aria-label={t('项目终端')}>
        {selected && <select className="qn-input min-w-0 flex-1 truncate" aria-label={t('切换终端')} value={termId ?? ''}
          disabled={busy} onChange={(event) => { setTermId(event.target.value); setClosing(false); setMenu(false) }}>
          {list?.map((item, index) => <option key={item.termId} value={item.termId}>{t('终端 {index}', { index: index + 1 })}{item.alive ? '' : t(' · 已退出')}</option>)}
        </select>}
        <Button variant={selected ? 'ghost' : 'primary'} aria-label={t('新建终端')} disabled={!connected || busy || list === null || needsTarget}
          onClick={() => void open()}><Plus size={19} aria-hidden />{!selected && t('新建终端')}</Button>
        {selected && <Button variant="ghost" aria-label={t('终端操作')} onClick={() => setMenu(true)}><Ellipsis size={19} aria-hidden /></Button>}
      </div>
      {closing && selected && (
        <div className="flex items-center gap-2 qn-surface px-2 text-sm">
          <span className="flex-1">{t('关闭会终止该终端。')}</span>
          <Button variant="ghost" disabled={busy} onClick={() => setClosing(false)}>{t('取消')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void terminate()}>{t('关闭')}</Button>
        </div>
      )}
      {error && <Note message={error} tone="error" actionLabel={needsTarget ? t('连接目标') : t('重试')}
        onAction={() => needsTarget ? requestConnect(project.targetId) : setRefresh((attempt) => attempt + 1)} />}
      {list === null && connected && <Loading text={t('正在读取可接回的项目终端…')} />}
      {list !== null && !selected && busy && <Loading text={t('正在新建终端…')} />}
      {!connected && connectionWarning && <Note message={connectionWarning} tone="warn" />}
      {list?.length === 0 && !error && !busy && <p className="py-5 text-center text-sm text-qn-muted">{t('该项目还没有手机终端。')}</p>}
      {desktopId && selected && <TerminalScreen key={`${desktopId}:${selected.termId}`} desktopId={desktopId} project={project} info={selected}
        menu={menu} busy={busy} onCloseMenu={() => setMenu(false)} onCloseTerminal={() => { setMenu(false); setClosing(true) }} />}
    </section>
  )
}
