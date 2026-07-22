import { useEffect, useState } from 'react'
import {
  Layers,
  X,
  FolderOpen,
  RefreshCw,
  Pencil,
  Trash2,
  Plus,
  Check,
} from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import EmptyState from './EmptyState'
import Tooltip from './Tooltip'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import {
  activateNamedWorkspace,
  deleteNamedWorkspace,
  getActiveNamedWorkspaceId,
  listNamedWorkspaces,
  renameNamedWorkspace,
  saveVisibleProjectsAsWorkspace,
  updateNamedWorkspaceSessions,
} from '../lib/namedWorkspaceActions'
import {
  formatNamedWorkspaceName,
  NAMED_WORKSPACE_CHANGE_EVENT,
  type NamedWorkspace,
} from '../lib/namedWorkspacePersist'

export default function WorkspaceManager() {
  const { t } = useI18n()
  const closeWorkspaceManager = useUIStore(s => s.closeWorkspaceManager)
  const [workspaces, setWorkspaces] = useState<NamedWorkspace[]>(() => listNamedWorkspaces())
  const [activeId, setActiveId] = useState<string | null>(() => getActiveNamedWorkspaceId())
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = () => {
    setWorkspaces(listNamedWorkspaces())
    setActiveId(getActiveNamedWorkspaceId())
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWorkspaceManager()
    }
    const onCatalog = () => refresh()
    window.addEventListener('keydown', onKey)
    window.addEventListener(NAMED_WORKSPACE_CHANGE_EVENT, onCatalog)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(NAMED_WORKSPACE_CHANGE_EVENT, onCatalog)
    }
  }, [closeWorkspaceManager])

  const handleOpen = async (workspace: NamedWorkspace) => {
    if (busyId) return
    setBusyId(workspace.id)
    try {
      const ok = await activateNamedWorkspace(workspace.id)
      if (ok) {
        refresh()
        closeWorkspaceManager()
      } else {
        refresh()
      }
    } finally {
      setBusyId(null)
    }
  }

  const handleUpdate = async (workspace: NamedWorkspace) => {
    if (busyId) return
    setBusyId(workspace.id)
    try {
      await updateNamedWorkspaceSessions(workspace.id)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  const handleRename = async (workspace: NamedWorkspace) => {
    if (busyId) return
    setBusyId(workspace.id)
    try {
      await renameNamedWorkspace(workspace.id)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (workspace: NamedWorkspace) => {
    if (busyId) return
    setBusyId(workspace.id)
    try {
      await deleteNamedWorkspace(workspace.id)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  const handleSaveCurrent = async () => {
    if (busyId) return
    setBusyId('__save__')
    try {
      await saveVisibleProjectsAsWorkspace()
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <ModalOverlay onDismiss={closeWorkspaceManager}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-manager-title"
        aria-describedby="workspace-manager-description"
        className="ui-font-scaled modal-content-enter relative w-full max-w-[560px] max-h-[80vh] flex flex-col rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        onPointerDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-border-strong flex-shrink-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
            <Layers size={16} className="text-fg-muted" />
            <h2 id="workspace-manager-title">{t('多项目工作区')}</h2>
            <span id="workspace-manager-description" className="text-ui-sm font-normal text-fg-muted">
              {t('共 {count} 个', { count: workspaces.length })}
            </span>
          </div>
          <button
            type="button"
            aria-label={t('关闭')}
            onClick={closeWorkspaceManager}
            className="p-1 rounded text-fg-dim hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0">
          <button
            type="button"
            disabled={busyId === '__save__'}
            onClick={() => void handleSaveCurrent()}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded border border-border-strong text-fg hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            <Plus size={13} /> {t('保存当前顶栏项目')}
          </button>
          <span className="text-ui-sm text-fg-muted">
            {t('将当前顶栏可见项目及其标签/终端快照打包')}
          </span>
        </div>

        <div className="flex-1 overflow-auto">
          {workspaces.length === 0 ? (
            <EmptyState
              className="py-10"
              icon={<Layers size={28} strokeWidth={1.2} />}
              title={t('暂无多项目工作区。可先在顶栏显示相关项目，再点上方保存。')}
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {workspaces.map(workspace => {
                const isActive = activeId === workspace.id
                const busy = busyId === workspace.id
                return (
                  <li
                    key={workspace.id}
                    className={`px-4 py-3 ${isActive ? 'bg-bg-active/40' : 'hover:bg-bg-hover/60'}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[13px] text-fg font-medium">
                          {isActive && <Check size={13} className="text-accent flex-shrink-0" />}
                          <span className="truncate">
                            {formatNamedWorkspaceName(workspace.name, t)}
                          </span>
                          <span className="text-[11px] text-fg-muted font-normal flex-shrink-0">
                            {t('{count} 个项目', { count: workspace.members.length })}
                          </span>
                        </div>
                        <Tooltip
                          label={workspace.members.map(m => m.name).join(' · ')}
                          side="bottom"
                          onlyWhenOverflow
                          wrapperClassName="mt-1 block min-w-0"
                        >
                          <div className="text-ui-sm mt-1 truncate text-fg-muted">
                            {workspace.members.map(m => m.name).join(' · ')}
                          </div>
                        </Tooltip>
                      </div>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <ActBtn
                          label={t('打开')}
                          disabled={busy}
                          onClick={() => void handleOpen(workspace)}
                        >
                          <FolderOpen size={14} />
                        </ActBtn>
                        <ActBtn
                          label={t('更新会话')}
                          disabled={busy}
                          onClick={() => void handleUpdate(workspace)}
                        >
                          <RefreshCw size={14} />
                        </ActBtn>
                        <ActBtn
                          label={t('重命名')}
                          disabled={busy}
                          onClick={() => void handleRename(workspace)}
                        >
                          <Pencil size={14} />
                        </ActBtn>
                        <ActBtn
                          label={t('删除')}
                          danger
                          disabled={busy}
                          onClick={() => void handleDelete(workspace)}
                        >
                          <Trash2 size={14} />
                        </ActBtn>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end px-4 py-2.5 border-t border-border-strong flex-shrink-0">
          <button
            type="button"
            onClick={closeWorkspaceManager}
            className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors"
          >
            {t('完成')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function ActBtn({
  label,
  onClick,
  danger,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`p-1 rounded transition-colors disabled:opacity-40
          ${danger
            ? 'text-fg-dim hover:text-danger'
            : 'text-fg-dim hover:text-fg hover:bg-bg-active'}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}
