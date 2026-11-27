import { useState } from 'react'
import { create } from 'zustand'
import {
  Check,
  ChevronRight,
  ChevronsDownUp,
  Download,
  EyeOff,
  FolderPlus,
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
import { t, translateMessage } from '@qn/codex-client'
import type { DirectTarget, SshTarget, Target, TargetState } from '../../../../shared/backendApi'
import { isTargetActive, matchTarget, targetDotClass, targetStateLabel } from '../../lib/targetStatus'
import { useProjects } from '../../store/projects'
import { sidebarTargets, useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger } from '../primitives'
import { SearchField } from '../SearchField'
import { StatusDot } from '../StatusDot'
import { targetDisplayName } from '../targetName'
import { EmptyState, ErrorNote, IconButton, Modal } from '../ui'

export type TargetActions = {
  onAdd: () => void
  onEdit: (target: SshTarget | DirectTarget) => void
  /** 设为活动目标（同时加入侧栏），未连接时发起连接。 */
  onSelect: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onForgetSecret: (id: string) => void
}

export function TargetGlyph({
  target,
  state,
  size = 28,
}: {
  target: Target
  state: TargetState
  size?: number
}) {
  const Icon = target.kind === 'ssh' ? Server : target.kind === 'direct' ? Zap : Monitor
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-lg border border-qn-border bg-qn-panel text-qn-muted"
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.7} />
      <StatusDot
        className={`absolute -bottom-0.5 -right-0.5 size-2.5 border-2 border-qn-sidebar ${targetDotClass[state]}`}
      />
    </span>
  )
}

export function targetSubtitle(target: Target): string {
  if (target.kind === 'direct') return `${target.host}:${target.port} · ${t('直连')}`
  if (target.kind === 'ssh') {
    return `${target.username}@${target.host}${target.port === 22 ? '' : `:${target.port}`}${target.direct ? ` · ${t('直连加速')}` : ''}`
  }
  return t('这台电脑')
}

// 确认框不能挂在菜单里：选择面板点菜单项会先关闭面板，菜单随之卸载。
const useForceUpdate = create<{ target: Target | null }>(() => ({ target: null }))

/** 强制更新 Server 的确认框，侧栏里渲染一次。 */
export function ForceUpdateDialog() {
  const target = useForceUpdate((s) => s.target)
  const forceUpdate = useTargets((s) => s.forceUpdate)
  if (!target) return null
  const close = () => useForceUpdate.setState({ target: null })
  return (
    <Modal
      title={t('强制更新 Server？')}
      description={t('如果「{name}」仍在运行旧版 Server，更新会重启 Server、中断正在进行的任务并关闭该目标的终端。', { name: targetDisplayName(target) })}
      onClose={close}
      width="max-w-md"
      bodyClassName="hidden"
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" className="qn-button-subtle" onClick={close}>{t('取消')}</button>
          <button
            type="button"
            className="qn-button bg-qn-danger hover:bg-qn-danger"
            onClick={() => {
              close()
              void forceUpdate(target.id)
            }}
          >
            {t('强制更新')}
          </button>
        </div>
      )}
    >
      {null}
    </Modal>
  )
}

/** 收起会话（仅侧栏） / 强制更新 / 编辑 / 忘记密码 / 从侧栏移除 / 删除：侧栏分组头与选择面板共用。 */
function TargetMenu({
  target,
  actions,
  onOpenChange,
  inSidebar,
}: {
  target: Target
  actions: TargetActions
  onOpenChange?: (open: boolean) => void
  inSidebar: boolean
}) {
  const remove = useTargets((s) => s.remove)
  const hide = useTargets((s) => s.hideFromSidebar)
  const state = useTargets((s) => s.states[target.id]?.state ?? 'idle')
  const active = isTargetActive(state)
  const canUpdate = target.kind !== 'direct' && (state === 'ready' || state === 'error')
  if (target.kind === 'local' && !canUpdate && !inSidebar) return null
  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <IconButton label={t('更多操作')} size="sm">
          <MoreHorizontal size={14} />
        </IconButton>
      </MenuTrigger>
      {/* 关闭时悬停按钮可能先隐藏，菜单淡出期间也要随锚点隐藏，避免跳到左上角。 */}
      <MenuContent align="end" hideWhenDetached>
        {inSidebar && (
          <MenuItem icon={<ChevronsDownUp size={14} />} onSelect={() => useProjects.getState().collapseAll(target.id)}>
            {t('收起全部会话')}
          </MenuItem>
        )}
        {inSidebar && (canUpdate || target.kind !== 'local') && <MenuSeparator />}
        {canUpdate && (
          <MenuItem danger icon={<Download size={14} />} onSelect={() => useForceUpdate.setState({ target })}>
            {`${t('强制更新')} Server`}
          </MenuItem>
        )}
        {canUpdate && target.kind !== 'local' && <MenuSeparator />}
        {target.kind !== 'local' && (
          <>
          <MenuItem icon={<Pencil size={14} />} onSelect={() => actions.onEdit(target)}>
            {t('编辑连接')}
          </MenuItem>
          <MenuItem icon={<KeyRound size={14} />} onSelect={() => actions.onForgetSecret(target.id)}>
            {t('忘记已保存的密码')}
          </MenuItem>
          {inSidebar && (
            <MenuItem
              icon={<EyeOff size={14} />}
              onSelect={() => {
                if (active) actions.onDisconnect(target.id)
                hide(target.id)
              }}
            >
              {active ? t('断开并从侧栏移除') : t('从侧栏移除')}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => void remove(target.id)}>
            {t('删除连接')}
          </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  )
}

/**
 * 侧栏"工作区"标题右侧的 + 按钮：可搜索的全部目标列表（导入后常有几十条），
 * 点选即加入侧栏铺开并连接；底部"添加 SSH 连接"。
 */
export function TargetPicker(actions: TargetActions) {
  const targets = useTargets((s) => s.targets)
  const states = useTargets((s) => s.states)
  const sidebarIds = useTargets((s) => s.sidebarIds)
  const selectedId = useTargets((s) => s.selectedId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const shown = new Set(sidebarTargets(targets, sidebarIds, selectedId).map((target) => target.id))
  const visible = targets.filter((target) => matchTarget(target, query))

  const run = (action: () => void) => {
    setOpen(false)
    setQuery('')
    action()
  }

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label={t('打开连接')} className="h-7 w-7">
          <Plus size={15} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[min(70vh,540px)] w-80 flex-col overflow-hidden p-0"
        aria-label={t('打开连接')}
      >
        <SearchField
          autoFocus
          label={t('搜索目标')}
          className="border-b border-qn-border px-3 py-2.5"
          placeholder={t('搜索 {count} 个目标（名称 / 主机 / 用户）', { count: targets.length })}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const first = visible[0]
            if (event.key === 'Enter' && first) run(() => actions.onSelect(first.id))
          }}
        />

        <div className="qn-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5" role="listbox">
          {visible.length === 0 && <EmptyState className="py-4 leading-5">{t('没有匹配的目标')}</EmptyState>}
          {visible.map((target) => {
            const state = states[target.id]?.state ?? 'idle'
            const inSidebar = shown.has(target.id)
            return (
              <div
                key={target.id}
                role="option"
                aria-selected={inSidebar}
                className="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-qn-hover has-[[data-state=open]]:bg-qn-hover"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
                  onClick={() => run(() => actions.onSelect(target.id))}
                >
                  <TargetGlyph target={target} state={state} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-qn-text">{targetDisplayName(target)}</span>
                    <span className="block truncate font-mono text-ui-xs leading-4 text-qn-dim">{targetSubtitle(target)}</span>
                  </span>
                  <span className={`shrink-0 text-ui-xs ${state === 'error' ? 'text-qn-danger' : 'text-qn-dim'} group-hover:hidden`}>
                    {targetStateLabel[state]}
                  </span>
                  {inSidebar && <Check size={14} className="shrink-0 text-qn-brand group-hover:hidden" aria-label={t('已在侧栏')} />}
                </button>
                <div className="hidden shrink-0 items-center group-hover:flex group-has-[[data-state=open]]:flex">
                  <TargetMenu target={target} actions={{ ...actions, onEdit: (edited) => run(() => actions.onEdit(edited)) }} inSidebar={false} />
                </div>
              </div>
            )
          })}
        </div>

        <div className="border-t border-qn-border p-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-ui text-qn-text outline-none hover:bg-qn-hover focus-visible:bg-qn-hover"
            onClick={() => run(actions.onAdd)}
          >
            <Plus size={15} className="text-qn-muted" /> {t('添加 SSH 连接')}
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}

/**
 * 展开时用紧凑标题保留折叠入口，连接提示与目标操作仍放在这一行。
 */
export function TargetSectionHeader({
  target,
  actions,
  collapsed,
  hasActiveSessions,
  onToggle,
}: {
  target: Target
  actions: TargetActions
  collapsed: boolean
  hasActiveSessions?: boolean
  onToggle: () => void
}) {
  const state = useTargets((s) => s.states[target.id]?.state ?? 'idle')
  const detail = useTargets((s) => s.states[target.id]?.detail)
  const current = useTargets((s) => s.selectedId === target.id)
  const openPicker = useUi((s) => s.openDirectoryPicker)
  const [menuOpen, setMenuOpen] = useState(false)
  const active = isTargetActive(state)
  const showState = collapsed || state !== 'ready'

  return (
    <div className="pt-1">
      <div
        className={`group flex h-9 items-center gap-1 rounded-lg pl-1 pr-1 ${menuOpen ? 'bg-qn-hover' : 'hover:bg-qn-hover'}`}
        title={`${targetDisplayName(target)} · ${targetSubtitle(target)}${detail && state !== 'error' ? ` · ${translateMessage(detail)}` : ''}`}
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover rounded-lg"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronRight
            size={13}
            className={`shrink-0 text-qn-dim transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          {/* 展开与折叠统一显示主机图标 + 加粗名称，分组布局下主机标题更醒目 */}
          <TargetGlyph target={target} state={state} size={22} />
          <span
            className={`min-w-0 flex-1 truncate text-[length:var(--qn-sidebar-list-font-size)] font-semibold ${current ? 'text-qn-text' : 'text-qn-text/80'}`}
          >
            {targetDisplayName(target)}
          </span>
          {hasActiveSessions && <StatusDot className="bg-qn-brand" title={t('有活动会话')} />}
          {!showState && <span className="sr-only">{targetStateLabel[state]}</span>}
        </button>
        {showState && (
          <span
            className={`shrink-0 pr-1.5 text-[length:var(--qn-sidebar-list-detail-font-size)] group-hover:hidden ${menuOpen ? 'hidden' : ''} ${
              state === 'error' ? 'text-qn-danger' : collapsed ? 'text-qn-dim' : 'text-qn-muted'
            }`}
          >
            {targetStateLabel[state]}
          </span>
        )}
        <span className={`shrink-0 items-center group-hover:flex ${menuOpen ? 'flex' : 'hidden'}`}>
          <IconButton label={t('添加项目')} size="sm" onClick={() => openPicker(target.id)}>
            <FolderPlus size={14} />
          </IconButton>
          {active ? (
            target.kind !== 'local' && (
              <IconButton label={t('断开')} size="sm" onClick={() => actions.onDisconnect(target.id)}>
                <Unplug size={14} />
              </IconButton>
            )
          ) : (
            <IconButton label={t('连接')} size="sm" onClick={() => actions.onConnect(target.id)}>
              <Wifi size={14} />
            </IconButton>
          )}
          <TargetMenu target={target} actions={actions} inSidebar onOpenChange={setMenuOpen} />
        </span>
      </div>
      <TargetConnectError targetId={target.id} onRetry={() => actions.onConnect(target.id)} />
    </div>
  )
}

/** 目标连接失败提示：主机标题下与混排列表里共用。 */
export function TargetConnectError({ targetId, withName, onRetry }: { targetId: string; withName?: boolean; onRetry: () => void }) {
  const error = useTargets((s) => s.connectErrors[targetId])
  const target = useTargets((s) => s.targets.find((item) => item.id === targetId))
  if (!error) return null
  // 混排时没有分组标题，错误前缀主机名才知道是哪台机器连不上；先翻译再拼，否则整句匹配不到译文。
  const message = withName && target ? `${targetDisplayName(target)}: ${translateMessage(error)}` : error
  return <ErrorNote message={message} variant="compact" className="mx-1 mb-1 mt-0.5" onRetry={onRetry} />
}
