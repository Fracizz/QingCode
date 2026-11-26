import '@xterm/xterm/css/xterm.css'
import type { TermInfo } from '@qn/protocol'
import { ChevronDown, ChevronUp, ClipboardPaste, Copy, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ErrorNote, IconButton } from '../../components/ui'
import { cn } from '../../lib/cn'
import { initialTerminalStatus, mountTerminalSession } from './terminalSession'

export default function TerminalView({
  targetId,
  info,
  ready,
  visible,
}: {
  targetId: string
  info: TermInfo
  ready: boolean
  visible: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const session = useRef<ReturnType<typeof mountTerminalSession> | null>(null)
  const original = useRef(info)
  const [status, setStatus] = useState(() => initialTerminalStatus(info))
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(true)
  const searchInput = useRef<HTMLInputElement>(null)

  const openSearch = () => {
    setSearchOpen(true)
    searchInput.current?.focus()
  }

  useEffect(() => {
    if (!host.current) return
    const mounted = mountTerminalSession(host.current, targetId, original.current, setStatus, openSearch)
    session.current = mounted
    return () => {
      session.current = null
      mounted.dispose()
    }
  }, [targetId])
  useEffect(() => session.current?.setReady(ready), [ready])
  useEffect(() => session.current?.setVisible(visible), [visible])

  useEffect(() => {
    if (searchOpen && visible) searchInput.current?.focus()
  }, [searchOpen, visible])

  const find = (value: string, backward = false, incremental = false) =>
    setFound(session.current?.find(value, backward, incremental) ?? false)
  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    session.current?.clearSearch()
  }
  const exitLabel = status.exit && (
    status.exit.signal ? `终端已退出（${status.exit.signal}）`
      : status.exit.code !== null ? `终端已退出（退出码 ${status.exit.code}）` : '终端已退出'
  )

  return (
    <div className={cn('absolute inset-0 flex min-h-0 flex-col', !visible && 'invisible pointer-events-none')} aria-hidden={!visible} data-terminal-input>
      <div className="flex shrink-0 items-center gap-1 px-2 py-0.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[11px] text-qn-muted" aria-live="polite">
          {exitLabel && <span>{exitLabel}</span>}
          {status.attaching && <span>正在接回终端…</span>}
          {status.historyLost && <span className="text-qn-warn">部分历史输出已丢失</span>}
          {!status.supportsResize && <span>当前终端尺寸固定</span>}
        </div>
        <IconButton size="sm" label="复制选中内容（Ctrl Shift C）" onClick={() => void session.current?.copy()}>
          <Copy size={13} />
        </IconButton>
        <IconButton size="sm" label="粘贴（Ctrl Shift V）" disabled={!status.writable} onClick={() => void session.current?.paste()}>
          <ClipboardPaste size={13} />
        </IconButton>
        <IconButton size="sm" label="搜索终端（Ctrl Shift F）" aria-expanded={searchOpen} onClick={openSearch}>
          <Search size={13} />
        </IconButton>
      </div>
      {status.error && (
        <div className="shrink-0 px-2">
          <ErrorNote
            message={status.error}
            onRetry={ready && status.attachFailed ? () => session.current?.attach() : undefined}
            onClose={() => session.current?.dismissError()}
          />
        </div>
      )}
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-qn-border px-2 pb-1">
          <input
            ref={searchInput}
            type="search"
            aria-label="搜索终端输出"
            value={query}
            placeholder="搜索终端输出"
            className="h-7 min-w-0 flex-1 rounded border border-qn-border-strong bg-qn-bg px-2 text-[12px] outline-none focus:border-qn-accent"
            onChange={(event) => {
              const value = event.target.value
              setQuery(value)
              find(value, false, true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                find(query, event.shiftKey)
              }
            }}
          />
          {query && !found && <span className="text-[11px] text-qn-muted" role="status">无匹配</span>}
          <IconButton size="sm" label="上一个匹配" disabled={!query} onClick={() => find(query, true)}><ChevronUp size={14} /></IconButton>
          <IconButton size="sm" label="下一个匹配" disabled={!query} onClick={() => find(query)}><ChevronDown size={14} /></IconButton>
          <IconButton size="sm" label="关闭终端搜索" onClick={closeSearch}><X size={14} /></IconButton>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={host} className="absolute inset-x-2 inset-y-1" />
      </div>
    </div>
  )
}
