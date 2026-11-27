import { useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Download,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
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
import { SearchField } from '../SearchField'
import { StatusDot } from '../StatusDot'
import { EmptyState, ErrorNote, IconButton, Modal } from '../ui'

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
      <StatusDot
        className={`absolute -bottom-0.5 -right-0.5 size-2.5 border-2 border-qn-elevated ${targetDotClass[state]}`}
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
  const forceUpdate = useTargets((s) => s.forceUpdate)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [updateTarget, setUpdateTarget] = useState<Target | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const updateDialogOpen = useRef(false)

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

  const closeUpdateDialog = () => {
    updateDialogOpen.current = false
    setUpdateTarget(null)
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
            ref={trigger}
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <StatusDot className={`size-2 ${targetDotClass[currentState]}`} />
                <span className="truncate text-[length:var(--qn-sidebar-title-font-size)] leading-tight font-semibold text-qn-text">
                  {current?.name ?? (loaded ? '无目标' : '加载中…')}
                </span>
                <ChevronDown size={15} className="shrink-0 text-qn-muted" />
              </span>
              <span className="mt-0.5 block truncate pl-3.5 text-[length:var(--qn-sidebar-detail-font-size)] leading-[1.35] text-qn-muted">
                <span className={currentState === 'error' ? 'text-qn-danger' : ''}>{targetStateLabel[currentState]}</span>
                {currentDetail && currentState !== 'error' && <> · {currentDetail}</>}
              </span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="flex max-h-[min(70vh,540px)] w-[var(--radix-popover-trigger-width)] min-w-72 flex-col overflow-hidden p-0 text-[length:var(--qn-sidebar-list-font-size)] leading-tight"
          aria-label="切换目标"
          onCloseAutoFocus={(event: Event) => { if (updateDialogOpen.current) event.preventDefault() }}
        >
          <SearchField
            autoFocus
            label="搜索目标"
            className="border-b border-qn-border px-3 py-2.5"
            inputClassName="text-[length:inherit]"
            placeholder={`搜索 ${targets.length} 个目标（名称 / 主机 / 用户）`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const first = visible[0]
              if (event.key === 'Enter' && first) run(() => actions.onSelect(first.id))
            }}
          />

          <div className="qn-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5" role="listbox">
            {visible.length === 0 && <EmptyState className="py-4 text-[length:inherit] leading-tight">没有匹配的目标</EmptyState>}
            {visible.map((target) => {
              const state = stateOf(target.id)
              const selected = target.id === current?.id
              const canUpdate = target.kind !== 'direct' && (state === 'ready' || state === 'error')
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
                      <span className="block truncate text-qn-text">{target.name}</span>
                      <span className="block truncate font-mono text-[length:var(--qn-sidebar-list-detail-font-size)] leading-[1.45] text-qn-muted">{subtitle(target)}</span>
                    </span>
                    <span className={`shrink-0 text-[length:var(--qn-sidebar-list-detail-font-size)] ${state === 'error' ? 'text-qn-danger' : 'text-qn-muted'} group-hover:hidden`}>
                      {targetStateLabel[state]}
                    </span>
                    {selected && <Check size={14} className="shrink-0 text-qn-brand group-hover:hidden" />}
                  </button>
                  <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex group-has-[[data-state=open]]:flex">
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
                    {(target.kind !== 'local' || canUpdate) && (
                      <Menu>
                        <MenuTrigger asChild>
                          <IconButton label="更多操作" className="h-7 w-7">
                            <MoreHorizontal size={14} />
                          </IconButton>
                        </MenuTrigger>
                        <MenuContent align="end">
                          {canUpdate && (
                            <MenuItem danger icon={<Download size={14} />} onSelect={() => run(() => {
                              updateDialogOpen.current = true
                              setUpdateTarget(target)
                            })}>
                              强制更新 Server
                            </MenuItem>
                          )}
                          {canUpdate && target.kind !== 'local' && <MenuSeparator />}
                          {target.kind !== 'local' && (
                            <>
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
                            </>
                          )}
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="border-t border-qn-border p-1.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-qn-text outline-none hover:bg-qn-hover focus-visible:bg-qn-hover"
              onClick={() => run(actions.onAdd)}
            >
              <Plus size={15} className="text-qn-muted" /> 添加 SSH 连接
            </button>
          </div>
        </PopoverContent>
      </PopoverRoot>

      {updateTarget && (
        <Modal
          title="强制更新 Server？"
          description={`如果「${updateTarget.name}」仍在运行旧版 Server，更新会重启 Server、中断正在进行的任务并关闭该目标的终端。`}
          onClose={closeUpdateDialog}
          onCloseAutoFocus={(event: Event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
          width="max-w-md"
          bodyClassName="hidden"
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={closeUpdateDialog}>取消</button>
              <button
                type="button"
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                onClick={() => {
                  closeUpdateDialog()
                  void forceUpdate(updateTarget.id)
                }}
              >
                强制更新
              </button>
            </div>
          )}
        >
          {null}
        </Modal>
      )}

      {current && currentError && (
        <ErrorNote
          message={currentError}
          variant="compact"
          className="mx-1 mt-1.5"
          onRetry={() => actions.onConnect(current.id)}
        />
      )}
      <ErrorNote message={loadError} variant="compact" className="mx-1 mt-1.5" />
    </div>
  )
}
