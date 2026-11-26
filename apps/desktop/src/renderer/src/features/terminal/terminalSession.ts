import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { TermDataEvt, TermErrorEvt, TermExitEvt, TermExitInfo, TermInfo, TermOutputChunk, TermResizedEvt } from '@qn/protocol'
import { DEFAULT_FONT_SIZES } from '../../../../shared/fontSizes'
import { copyText } from '../../lib/clipboard'
import { friendlyError } from '../../lib/errors'
import { onServerEvt, serverCall } from '../workspace/serverCall'
import { planTerminalReplay } from './terminalModel'

export type TerminalStatus = {
  writable: boolean
  attaching: boolean
  attachFailed: boolean
  historyLost: boolean
  supportsResize: boolean
  exit: TermExitInfo | undefined
  error: string | null
}

export function initialTerminalStatus(info: TermInfo): TerminalStatus {
  return {
    writable: false,
    attaching: false,
    attachFailed: false,
    historyLost: false,
    supportsResize: info.supportsResize,
    exit: info.exit,
    error: null,
  }
}

const MAX_INPUT_BYTES = 1024 * 1024
const encoder = new TextEncoder()
const rawBytes = (data: string): Uint8Array => Uint8Array.from(data, (character) => character.charCodeAt(0))

function encodeBytes(data: Uint8Array): string {
  const parts: string[] = []
  for (let start = 0; start < data.length; start += 8192) {
    parts.push(String.fromCharCode(...data.subarray(start, start + 8192)))
  }
  return btoa(parts.join(''))
}

function openLink(event: MouseEvent, url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  event.preventDefault()
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function mountTerminalSession(
  host: HTMLElement,
  targetId: string,
  info: TermInfo & { created?: boolean },
  onStatus: (status: TerminalStatus) => void,
  onSearch: () => void,
) {
  const { termId } = info
  const style = getComputedStyle(host)
  const terminal = new Terminal({
    cols: info.cols,
    rows: info.rows,
    cursorBlink: true,
    disableStdin: true,
    allowProposedApi: true,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: DEFAULT_FONT_SIZES.terminalFontSize,
    scrollback: 3000,
    theme: {
      background: style.getPropertyValue('--color-qn-bg').trim(),
      foreground: style.getPropertyValue('--color-qn-text').trim(),
      cursor: style.getPropertyValue('--color-qn-brand').trim(),
    },
    linkHandler: { activate: openLink },
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  terminal.loadAddon(new WebLinksAddon(openLink))
  terminal.open(host)

  let status = initialTerminalStatus(info)
  let lastSeq = 0
  let starting = info.created === true
  let visible = false
  let ready = false
  let disposed = false
  let activeConnection = 0
  let off: Array<() => void> = []
  let fitTimer: ReturnType<typeof setTimeout> | undefined

  const update = (patch: Partial<TerminalStatus>) => {
    if (disposed) return
    status = { ...status, ...patch }
    terminal.options.disableStdin = !status.writable
    onStatus(status)
  }

  const reportError = (err: unknown, fallback: string) => update({ error: friendlyError(err, fallback) })

  const write = (bytes: Uint8Array) => {
    if (!status.writable || bytes.length === 0) return
    if (bytes.length > MAX_INPUT_BYTES) {
      update({ error: '单次终端输入不能超过 1 MiB' })
      return
    }
    const connection = activeConnection
    void serverCall(targetId, 'term.write', { termId, data: encodeBytes(bytes) }).catch((err: unknown) => {
      if (connection === activeConnection) reportError(err, '终端输入发送失败')
    })
  }

  const resize = (cols: number, rows: number) => {
    if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows)
  }

  const scheduleFit = () => {
    clearTimeout(fitTimer)
    if (!visible || !status.writable || !status.supportsResize) return
    fitTimer = setTimeout(() => {
      const dimensions = fit.proposeDimensions()
      if (!dimensions || !host.clientWidth || !host.clientHeight) return
      const cols = Math.min(1000, dimensions.cols)
      const rows = Math.min(1000, dimensions.rows)
      if (terminal.cols === cols && terminal.rows === rows) return
      const connection = activeConnection
      void serverCall(targetId, 'term.resize', { termId, cols, rows }).then((result) => {
        if (connection === activeConnection) resize(result.cols, result.rows)
      }).catch((err: unknown) => {
        if (connection === activeConnection) reportError(err, '调整终端尺寸失败')
      })
    }, 80)
  }

  const stopListening = () => {
    activeConnection += 1
    for (const unsubscribe of off) unsubscribe()
    off = []
    clearTimeout(fitTimer)
  }

  const attach = () => {
    if (!ready) return
    stopListening()
    const connection = activeConnection
    const current = () => connection === activeConnection
    const sinceSeq = lastSeq
    let pending: TermOutputChunk[] | null = []
    let exitDuringAttach: TermExitInfo | undefined
    let resizeDuringAttach: TermResizedEvt | undefined
    let drawingSnapshot = false

    const writeOutput = (chunk: TermOutputChunk) => {
      if (chunk.seq <= lastSeq) return
      terminal.write(rawBytes(atob(chunk.data)))
      lastSeq = chunk.seq
    }
    const onTerminalEvent = <T extends { termId: string }>(name: string, event: (payload: T) => void) =>
      onServerEvt<T>(name, (eventTargetId, payload) => {
        if (eventTargetId === targetId && payload.termId === termId) event(payload)
      })
    const onAttachError = (err: unknown) => {
      if (!current()) return
      stopListening()
      update({ attaching: false, attachFailed: true })
      reportError(err, '接回终端失败')
    }

    update({ writable: false, attaching: true, attachFailed: false, error: null })
    off = [
      onTerminalEvent<TermDataEvt>('term.data', (chunk) => {
        if (pending) pending.push(chunk)
        else if (chunk.seq > lastSeq + 1) attach()
        else writeOutput(chunk)
      }),
      onTerminalEvent<TermExitEvt>('term.exit', ({ code, signal }) => {
        if (pending) exitDuringAttach = { code, signal }
        update({ writable: false, exit: { code, signal } })
      }),
      onTerminalEvent<TermResizedEvt>('term.resized', (dimensions) => {
        resizeDuringAttach = dimensions
        if (!pending && !drawingSnapshot) resize(dimensions.cols, dimensions.rows)
      }),
      onTerminalEvent<TermErrorEvt>('term.error', ({ message }) => update({ error: message })),
    ]
    void serverCall(targetId, 'term.attach', { termId, sinceSeq }).then((result) => {
      if (!current()) return
      const applyReplay = () => {
        if (!current()) return
        try {
          const replay = planTerminalReplay(sinceSeq, result, pending ?? [])
          pending = null
          lastSeq = replay.baseSeq
          if (replay.reset) terminal.reset()
          const dimensions = resizeDuringAttach ?? result
          if (replay.snapshot) {
            drawingSnapshot = true
            resize(replay.snapshot.cols, replay.snapshot.rows)
            terminal.write(rawBytes(atob(replay.snapshot.data)), () => {
              if (!current()) return
              drawingSnapshot = false
              const latest = resizeDuringAttach ?? result
              resize(latest.cols, latest.rows)
            })
          } else {
            resize(dimensions.cols, dimensions.rows)
          }
          const exit = exitDuringAttach ?? result.exit
          // 新 shell 的启动输出可能含等待应答的查询；已存在会话的回放保持只读。
          const startupInput = starting && !replay.reset && result.alive && !exit
          starting = false
          update({
            exit,
            writable: startupInput,
            supportsResize: result.supportsResize,
            historyLost: replay.reset ? replay.historyLost : status.historyLost,
          })
          for (const chunk of replay.chunks) writeOutput(chunk)

          // 旧会话等历史写入解析完成后才恢复输入，避免重复应答终端查询。
          terminal.write('', () => {
            if (!current()) return
            update({ attaching: false, writable: result.alive && !status.exit })
            scheduleFit()
          })
        } catch (err) {
          onAttachError(err)
        }
      }
      // 先处理已排队的写入，再清理 xterm 的解析状态与屏幕。
      if (result.mode === 'replay') applyReplay()
      else terminal.write('', applyReplay)
    }).catch(onAttachError)
  }

  const copy = async () => {
    const selection = terminal.getSelection()
    if (selection && !await copyText(selection)) update({ error: '无法复制终端选中的内容' })
  }

  const paste = async () => {
    if (!status.writable) return
    const connection = activeConnection
    try {
      const text = await navigator.clipboard.readText()
      if (!disposed && connection === activeConnection && status.writable) {
        terminal.paste(text)
        if (visible) terminal.focus()
      }
    } catch {
      update({ error: '无法读取剪贴板，请使用系统粘贴' })
    }
  }

  terminal.onData((data) => write(encoder.encode(data)))
  terminal.onBinary((data) => write(rawBytes(data)))
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return true
    const key = event.key.toLowerCase()
    if (key === 'c') void copy()
    else if (key === 'v') void paste()
    else if (key === 'f') onSearch()
    else return true
    event.preventDefault()
    return false
  })

  const observer = new ResizeObserver(scheduleFit)
  observer.observe(host)

  return {
    setFontSize(fontSize: number) {
      terminal.options.fontSize = fontSize
      scheduleFit()
    },
    setReady(next: boolean) {
      if (ready === next) return
      ready = next
      if (ready) attach()
      else {
        stopListening()
        update({ writable: false, attaching: false })
      }
    },
    setVisible(next: boolean) {
      visible = next
      if (visible) terminal.focus()
      scheduleFit()
    },
    copy,
    paste,
    find(query: string, backward: boolean, incremental: boolean) {
      if (!query) {
        search.clearDecorations()
        return false
      }
      return backward ? search.findPrevious(query) : search.findNext(query, { incremental })
    },
    clearSearch() {
      search.clearDecorations()
      terminal.focus()
    },
    attach,
    dismissError: () => update({ error: null }),
    dispose() {
      disposed = true
      observer.disconnect()
      stopListening()
      if (ready) void serverCall(targetId, 'term.detach', { termId }).catch(() => {})
      terminal.dispose()
    },
  }
}
