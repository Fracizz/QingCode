import { useState } from 'react'
import {
  Check,
  ChevronDown,
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
  Zap,
} from 'lucide-react'
import type { DirectTarget, SshTarget, Target, TargetState } from '../../../../shared/backendApi'
import { isTargetActive, matchTarget, targetDotClass, targetStateLabel } from '../../lib/targetStatus'
import { useTargets } from '../../store/targets'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger } from '../primitives'
import { RateLimitHint } from '../RateLimitHint'
import { IconButton } from '../ui'

export type TargetActions = {
  onAdd: () => void
  onEdit: (target: SshTarget | DirectTarget) => void
  onSelect: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onForgetSecret: (id: string) => void
}

function TargetGlyph({ target, state, size = 28 }: { target: Target; state: TargetState; size?: number }) {
  const Icon = target.kind === 'ssh' ? Server : target.kind === 'direct' ? Zap : Monitor
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-lg border border-qn-border bg-qn-panel text-qn-muted"
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.7} />
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-qn-elevated ${targetDotClass[state]}`}
      />
    </span>
  )
}

function subtitle(target: Target): string {
  if (target.kind === 'direct') return `${target.host}:${target.port} · 直连`
  if (target.kind === 'ssh') {
    return `${target.username}@${target.host}${target.port === 22 ? '' : `:${target.port}`}${target.direct ? ' · 直连加速' : ''}`
  }
  return '这台电脑'
}

/**
 * 侧栏顶部的目标切换器（位置与样式对应 Codex 侧栏左上角的 "Codex ▾"）。
 * 连接一多（导入后常有几十条）列表既占宽又难找，所以用可搜索的弹出面板（Radix Popover，自带焦点管理与 Esc 关闭）。
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

  const stateOf = (id: string): TargetState => states[id]?.state ?? 'idle'
  const current = targets.find((item) => item.id === selectedId) ?? targets[0]
  const currentState = current ? stateOf(current.id) : 'idle'
  const currentDetail = current ? states[current.id]?.detail : undefined
  const currentError = current ? connectErrors[current.id] : undefined
  const visible = targets.filter((target) => matchTarget(target, query))

  const run = (action: () => void) => {
    setOpen(false)
    setQuery('')
    action()
  }

  return (
    <div className="px-2 pt-2">
      <PopoverRoot
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${targetDotClass[currentState]}`} />
                <span className="truncate text-[16px] font-semibold text-qn-text">
                  {current?.name ?? (loaded ? '无目标' : '加载中…')}
                </span>
                <ChevronDown size={15} className="shrink-0 text-qn-muted" />
              </span>
              <span className="mt-0.5 block truncate pl-3.5 text-[12px] leading-4 text-qn-muted">
                <span className={currentState === 'error' ? 'text-qn-danger' : ''}>{targetStateLabel[currentState]}</span>
                {currentDetail && currentState !== 'error' && <> · {currentDetail}</>}
                {current && <RateLimitHint targetId={current.id} />}
              </span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="flex max-h-[min(70vh,540px)] w-[var(--radix-popover-trigger-width)] min-w-72 flex-col overflow-hidden p-0"
          aria-label="切换目标"
        >
          <div className="flex items-center gap-2 border-b border-qn-border px-3 py-2.5">
            <Search size={15} className="shrink-0 text-qn-dim" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[13px] text-qn-text outline-none placeholder:text-qn-dim"
              placeholder={`搜索 ${targets.length} 个目标（名称 / 主机 / 用户）`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible[0]) run(() => actions.onSelect(visible[0]!.id))
              }}
            />
          </div>

          <div className="qn-scroll min-h-0 flex-1 overflow-y-auto p-1" role="listbox">
            {visible.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-qn-muted">没有匹配的目标</div>}
            {visible.map((target) => {
              const state = stateOf(target.id)
              const selected = target.id === current?.id
              return (
                <div
                  key={target.id}
                  role="option"
                  aria-selected={selected}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 has-[[data-state=open]]:bg-qn-hover ${
                    selected ? 'bg-qn-active' : 'hover:bg-qn-hover'
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
                    onClick={() => run(() => actions.onSelect(target.id))}
                  >
                    <TargetGlyph target={target} state={state} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-qn-text">{target.name}</span>
                      <span className="block truncate font-mono text-[11px] leading-4 text-qn-dim">{subtitle(target)}</span>
                    </span>
                    <span className={`shrink-0 text-[11px] ${state === 'error' ? 'text-qn-danger' : 'text-qn-dim'} group-hover:hidden`}>
                      {targetStateLabel[state]}
                    </span>
                    {selected && <Check size={14} className="shrink-0 text-qn-brand group-hover:hidden" />}
                  </button>
                  <div className="hidden shrink-0 items-center group-hover:flex group-has-[[data-state=open]]:flex">
                    {isTargetActive(state) ? (
                      target.kind !== 'local' && (
                        <IconButton label="断开" className="h-7 w-7" onClick={() => run(() => actions.onDisconnect(target.id))}>
                          <Unplug size={14} />
                        </IconButton>
                      )
                    ) : (
                      <IconButton label="连接" className="h-7 w-7" onClick={() => run(() => actions.onConnect(target.id))}>
                        <Wifi size={14} />
                      </IconButton>
                    )}
                    {target.kind !== 'local' && (
                      <Menu>
                        <MenuTrigger asChild>
                          <IconButton label="更多操作" className="h-7 w-7">
                            <MoreHorizontal size={14} />
                          </IconButton>
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem icon={<Pencil size={14} />} onSelect={() => run(() => actions.onEdit(target))}>
                            编辑连接
                          </MenuItem>
                          <MenuItem icon={<KeyRound size={14} />} onSelect={() => run(() => actions.onForgetSecret(target.id))}>
                            忘记已保存的密码
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => run(() => void remove(target.id))}>
                            删除连接
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="border-t border-qn-border p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-qn-text outline-none hover:bg-qn-hover focus-visible:bg-qn-hover"
              onClick={() => run(actions.onAdd)}
            >
              <Plus size={15} className="text-qn-muted" /> 添加 SSH 连接
            </button>
          </div>
        </PopoverContent>
      </PopoverRoot>

      {current && currentError && (
        <div className="mx-1 mt-1.5 flex items-start gap-2 rounded-lg bg-qn-danger/10 px-2.5 py-1.5 text-[12px] leading-4 text-qn-danger">
          <span className="min-w-0 flex-1 break-words">{currentError}</span>
          <button type="button" className="shrink-0 underline" onClick={() => actions.onConnect(current.id)}>
            重试
          </button>
        </div>
      )}
      {loadError && (
        <div className="mx-1 mt-1.5 rounded-lg bg-qn-danger/10 px-2.5 py-1.5 text-[12px] text-qn-danger">{loadError}</div>
      )}
    </div>
  )
}
