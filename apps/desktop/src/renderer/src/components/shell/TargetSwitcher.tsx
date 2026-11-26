import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronsUpDown,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Server,
  Trash2,
  Unplug,
  Wifi,
} from 'lucide-react'
import type { SshTarget, Target, TargetState } from '../../../../shared/backendApi'
import { useDismiss } from '../../hooks/useDismiss'
import {
  isTargetActive,
  matchTarget,
  targetDotClass,
  targetStateLabel,
} from '../../lib/targetStatus'
import { useTargets } from '../../store/targets'
import { RateLimitHint } from '../RateLimitHint'

export type TargetActions = {
  onAdd: () => void
  onEdit: (target: SshTarget) => void
  onSelect: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onForgetSecret: (id: string) => void
}

function TargetGlyph({ target, state, size = 28 }: { target: Target; state: TargetState; size?: number }) {
  const Icon = target.kind === 'ssh' ? Server : Monitor
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-md border border-qn-border bg-qn-panel text-qn-muted"
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.7} />
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-qn-sidebar ${targetDotClass[state]}`}
      />
    </span>
  )
}

function subtitle(target: Target): string {
  return target.kind === 'ssh' ? `${target.username}@${target.host}${target.port === 22 ? '' : `:${target.port}`}` : '这台电脑'
}

/**
 * 侧栏顶部的目标切换器（类似 Slack / Linear 的工作区切换）。
 * 旧版把目标单独占一整列；连接一多（导入后常有几十条）列表既占宽又难找，改成可搜索的下拉，把横向空间让给对话区。
 */
export function TargetSwitcher(actions: TargetActions) {
  const targets = useTargets((s) => s.targets)
  const states = useTargets((s) => s.states)
  const connectErrors = useTargets((s) => s.connectErrors)
  const selectedId = useTargets((s) => s.selectedId)
  const loaded = useTargets((s) => s.loaded)
  const loadError = useTargets((s) => s.error)
  const remove = useTargets((s) => s.remove)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setMenuId(null)
    setQuery('')
  }, [])
  useDismiss(rootRef, open, close)

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  const stateOf = (id: string): TargetState => states[id]?.state ?? 'idle'
  const current = targets.find((item) => item.id === selectedId) ?? targets[0]
  const currentState = current ? stateOf(current.id) : 'idle'
  const currentDetail = current ? states[current.id]?.detail : undefined
  const currentError = current ? connectErrors[current.id] : undefined
  const visible = targets.filter((target) => matchTarget(target, query))

  const run = (action: () => void) => {
    close()
    action()
  }

  return (
    <div ref={rootRef} className="relative px-2 pt-2">
      <button
        type="button"
        className={`flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors ${
          open ? 'border-qn-border-strong bg-qn-hover' : 'border-transparent hover:bg-qn-hover'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {current ? (
          <TargetGlyph target={current} state={currentState} />
        ) : (
          <span className="h-7 w-7 animate-pulse rounded-md bg-qn-panel" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-qn-text">
            {current?.name ?? (loaded ? '无目标' : '加载中…')}
          </span>
          <span className="block truncate text-[11px] leading-4 text-qn-muted">
            <span className={currentState === 'error' ? 'text-qn-danger' : ''}>{targetStateLabel[currentState]}</span>
            {currentDetail && currentState !== 'error' && <> · {currentDetail}</>}
            {current && <RateLimitHint targetId={current.id} />}
          </span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-qn-dim" />
      </button>

      {current && currentError && !open && (
        <div className="mx-1 mt-1.5 flex items-start gap-2 rounded-md bg-qn-danger/10 px-2 py-1.5 text-[11px] leading-4 text-qn-danger">
          <span className="min-w-0 flex-1 break-words">{currentError}</span>
          <button type="button" className="shrink-0 underline" onClick={() => actions.onConnect(current.id)}>
            重试
          </button>
        </div>
      )}
      {loadError && !open && (
        <div className="mx-1 mt-1.5 rounded-md bg-qn-danger/10 px-2 py-1.5 text-[11px] text-qn-danger">{loadError}</div>
      )}

      {open && (
        <div
          className="qn-pop absolute left-2 right-2 top-full z-40 mt-1 flex max-h-[min(70vh,520px)] flex-col overflow-hidden rounded-lg border border-qn-border-strong bg-qn-elevated shadow-2xl"
          role="listbox"
          aria-label="切换目标"
        >
          <div className="flex items-center gap-2 border-b border-qn-border px-2.5 py-2">
            <Search size={13} className="shrink-0 text-qn-dim" />
            <input
              ref={searchRef}
              className="min-w-0 flex-1 bg-transparent text-xs text-qn-text outline-none placeholder:text-qn-dim"
              placeholder={`搜索 ${targets.length} 个目标（名称 / 主机 / 用户）`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible[0]) run(() => actions.onSelect(visible[0]!.id))
              }}
            />
          </div>

          <div className="qn-scroll min-h-0 flex-1 overflow-y-auto p-1">
            {visible.length === 0 && <div className="px-3 py-4 text-center text-xs text-qn-muted">没有匹配的目标</div>}
            {visible.map((target) => {
              const state = stateOf(target.id)
              const selected = target.id === current?.id
              return (
                <div
                  key={target.id}
                  role="option"
                  aria-selected={selected}
                  className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 ${
                    selected ? 'bg-qn-active' : 'hover:bg-qn-hover'
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    onClick={() => run(() => actions.onSelect(target.id))}
                  >
                    <TargetGlyph target={target} state={state} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-qn-text">{target.name}</span>
                      <span className="block truncate font-mono text-[10px] leading-4 text-qn-dim">
                        {subtitle(target)}
                      </span>
                    </span>
                    <span className={`shrink-0 text-[10px] ${state === 'error' ? 'text-qn-danger' : 'text-qn-dim'} group-hover:hidden`}>
                      {targetStateLabel[state]}
                    </span>
                    {selected && <Check size={13} className="shrink-0 text-qn-brand group-hover:hidden" />}
                  </button>
                  <div className="hidden shrink-0 items-center group-hover:flex">
                    {isTargetActive(state) ? (
                      target.kind === 'ssh' && (
                        <RowButton label="断开" onClick={() => run(() => actions.onDisconnect(target.id))}>
                          <Unplug size={13} />
                        </RowButton>
                      )
                    ) : (
                      <RowButton label="连接" onClick={() => run(() => actions.onConnect(target.id))}>
                        <Wifi size={13} />
                      </RowButton>
                    )}
                    {target.kind === 'ssh' && (
                      <RowButton label="更多操作" onClick={() => setMenuId((id) => (id === target.id ? null : target.id))}>
                        <MoreHorizontal size={13} />
                      </RowButton>
                    )}
                  </div>
                  {menuId === target.id && target.kind === 'ssh' && (
                    <div className="qn-pop absolute right-1 top-full z-50 mt-0.5 w-44 rounded-lg border border-qn-border-strong bg-qn-panel py-1 text-xs shadow-xl">
                      <MenuItem onClick={() => run(() => actions.onEdit(target))}>
                        <Pencil size={13} /> 编辑连接
                      </MenuItem>
                      <MenuItem onClick={() => run(() => actions.onForgetSecret(target.id))}>
                        <KeyRound size={13} /> 忘记已保存的密码
                      </MenuItem>
                      <MenuItem danger onClick={() => run(() => void remove(target.id))}>
                        <Trash2 size={13} /> 删除连接
                      </MenuItem>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="border-t border-qn-border p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-qn-text hover:bg-qn-hover"
              onClick={() => run(actions.onAdd)}
            >
              <Plus size={14} className="text-qn-muted" /> 添加 SSH 连接
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-qn-muted hover:bg-white/10 hover:text-qn-text"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 px-3 py-1.5 hover:bg-qn-hover ${danger ? 'text-qn-danger' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
