import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Layers, Plus, Settings2 } from 'lucide-react'
import Tooltip from './Tooltip'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import {
  activateNamedWorkspace,
  getActiveNamedWorkspaceId,
  listNamedWorkspaces,
  saveVisibleProjectsAsWorkspace,
} from '../lib/namedWorkspaceActions'
import {
  formatNamedWorkspaceName,
  NAMED_WORKSPACE_CHANGE_EVENT,
  type NamedWorkspace,
} from '../lib/namedWorkspacePersist'

const MENU_WIDTH = 260

function readWorkspaceState() {
  const workspaces = listNamedWorkspaces()
  const activeId = getActiveNamedWorkspaceId()
  return {
    workspaces,
    activeId,
    active: workspaces.find(w => w.id === activeId) ?? null,
  }
}

export default function WorkspaceMenu() {
  const { t } = useI18n()
  const openWorkspaceManager = useUIStore(s => s.openWorkspaceManager)

  const anchorRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({
    left: 0,
    top: 0,
    width: MENU_WIDTH,
    visibility: 'hidden',
  })
  const [workspaces, setWorkspaces] = useState<NamedWorkspace[]>(() => listNamedWorkspaces())
  const [activeId, setActiveId] = useState<string | null>(() => getActiveNamedWorkspaceId())
  const [active, setActive] = useState<NamedWorkspace | null>(() => readWorkspaceState().active)

  const refresh = () => {
    const next = readWorkspaceState()
    setWorkspaces(next.workspaces)
    setActiveId(next.activeId)
    setActive(next.active)
  }

  useEffect(() => {
    const onChange = () => refresh()
    window.addEventListener(NAMED_WORKSPACE_CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(NAMED_WORKSPACE_CHANGE_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  const close = () => setOpen(false)

  const positionDropdown = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8))
    setDropdownStyle({
      left,
      top: rect.bottom + 4,
      width: MENU_WIDTH,
      visibility: 'visible',
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    positionDropdown()
  }, [open])

  useEffect(() => {
    if (!open) return
    refresh()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (dropdownRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onReposition = () => positionDropdown()
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation()
    setOpen(v => !v)
  }

  const handleOpen = async (workspace: NamedWorkspace) => {
    if (busy) return
    setBusy(true)
    try {
      const ok = await activateNamedWorkspace(workspace.id)
      refresh()
      if (ok) close()
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async () => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await saveVisibleProjectsAsWorkspace()
      refresh()
      if (saved) close()
    } finally {
      setBusy(false)
    }
  }

  const handleManage = () => {
    close()
    openWorkspaceManager()
  }

  const buttonLabel = active ? formatNamedWorkspaceName(active.name, t) : t('工作区')
  const tipLabel = active
    ? `${t('多项目工作区')}: ${formatNamedWorkspaceName(active.name, t)}`
    : t('多项目工作区')

  return (
    <>
      <div ref={anchorRef} className="flex-shrink-0">
        <Tooltip label={tipLabel} side="bottom" wrapperClassName="flex-shrink-0">
          <button
            type="button"
            aria-label={t('多项目工作区')}
            aria-expanded={open}
            aria-haspopup="menu"
            disabled={busy}
            onClick={toggle}
            onDoubleClick={event => event.stopPropagation()}
            className={`flex max-w-[120px] items-center gap-1 h-6 rounded px-1.5 text-[12px] flex-shrink-0 transition-colors disabled:opacity-50
              ${open ? 'bg-bg-active text-fg' : 'text-fg-muted hover:text-fg hover:bg-bg-hover'}`}
          >
            <Layers size={13} className="flex-shrink-0" />
            <span className="truncate">{buttonLabel}</span>
            <ChevronDown
              size={12}
              className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
        </Tooltip>
      </div>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            className="ui-font-scaled fixed z-[100] rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45 max-h-[70vh] flex flex-col"
            style={dropdownStyle}
            onPointerDown={event => event.stopPropagation()}
            onContextMenu={event => event.preventDefault()}
          >
            <div className="px-3 py-1 text-[11px] font-semibold tracking-wide text-fg-muted">
              {t('多项目工作区')}
            </div>

            <div className="flex-1 overflow-auto">
              {workspaces.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-fg-muted">
                  {t('暂无工作区，可先保存当前顶栏项目')}
                </div>
              ) : (
                workspaces.map(workspace => {
                  const isActive = activeId === workspace.id
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => void handleOpen(workspace)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] outline-none disabled:opacity-50
                        ${isActive ? 'bg-bg-active text-fg' : 'text-fg hover:bg-bg-hover focus:bg-bg-active'}`}
                    >
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                        {isActive ? (
                          <Check size={13} className="text-accent" />
                        ) : (
                          <Layers size={13} className="text-fg-muted" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {formatNamedWorkspaceName(workspace.name, t)}
                      </span>
                      <span className="flex-shrink-0 text-[11px] text-fg-muted">
                        {t('{count} 个项目', { count: workspace.members.length })}
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="border-t border-border-strong mt-1 pt-1">
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => void handleSave()}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-fg hover:bg-bg-active focus:bg-bg-active outline-none disabled:opacity-50"
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
                  <Plus size={14} />
                </span>
                {t('保存当前顶栏项目')}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={handleManage}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-fg hover:bg-bg-active focus:bg-bg-active outline-none disabled:opacity-50"
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
                  <Settings2 size={14} />
                </span>
                {t('管理多项目工作区')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
