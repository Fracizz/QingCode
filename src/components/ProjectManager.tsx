import { useEffect, useMemo, useState } from 'react'
import {
  FolderPlus,
  Terminal as TerminalIcon,
  Pencil,
  LocateFixed,
  Trash2,
  EyeOff,
  Eye,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  Folder,
  Folders,
  AlertTriangle,
  ShieldOff,
  ShieldCheck,
  ShieldAlert,
  Layers,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useTerminalStore } from '../store/terminalStore'
import { useEditorStore } from '../store/editorStore'
import { confirmDialog } from '../store/confirmStore'
import {
  getWorkspaceTrust,
  restrictProject,
  trustProject,
  untrustProject,
  pushTrustedRootsToNative,
  WORKSPACE_TRUST_CHANGED_EVENT,
} from '../lib/workspaceTrust'
import {
  removeProjectWithConfirm,
  relocateProjectWithDialog,
  addTerminalProjectWithPrompt,
  renameProjectWithPrompt,
} from '../utils/projectActions'
import { saveSelectedProjectsAsWorkspace } from '../lib/namedWorkspaceActions'
import ModalOverlay from './ModalOverlay'
import SegmentedControl from './SegmentedControl'
import Tooltip from './Tooltip'
import type { Project } from '../types'
import { useI18n } from '../lib/i18n'

type SortKey = 'name' | 'path' | 'last_opened_at' | 'created_at'
type SortDir = 'asc' | 'desc'
type FilterMode = 'all' | 'visible' | 'hidden'

const SORT_LABELS: Record<SortKey, string> = {
  name: '名称',
  path: '路径',
  last_opened_at: '最近打开',
  created_at: '创建时间',
}

function timeAgo(ts: number, t: (source: string, values?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts
  const day = 24 * 60 * 60 * 1000
  if (diff < 60 * 1000) return t('刚刚')
  if (diff < 60 * 60 * 1000) return t('{count} 分钟前', { count: Math.floor(diff / 60000) })
  if (diff < day) return t('{count} 小时前', { count: Math.floor(diff / 3600000) })
  if (diff < 30 * day) return t('{count} 天前', { count: Math.floor(diff / day) })
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function ProjectManager() {
  const { language, t } = useI18n()
  const allProjects = useProjectStore(s => s.projects)
  const projects = useMemo(() => allProjects.filter(p => !p.ephemeral), [allProjects])
  const currentProject = useProjectStore(s => s.currentProject)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const switchProject = useProjectStore(s => s.switchProject)
  const hideProject = useProjectStore(s => s.hideProject)
  const unhideProject = useProjectStore(s => s.unhideProject)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const closeProjectManager = useUIStore(s => s.closeProjectManager)
  const openWorkspaceManager = useUIStore(s => s.openWorkspaceManager)

  const [sortKey, setSortKey] = useState<SortKey>('last_opened_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [trustTick, setTrustTick] = useState(0)

  useEffect(() => {
    const sync = () => setTrustTick(n => n + 1)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
    return () => window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
  }, [])

  const sortedProjects = useMemo(() => {
    let list = projects
    if (filter === 'visible') list = list.filter(p => !p.hidden)
    else if (filter === 'hidden') list = list.filter(p => p.hidden)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name, language)
      else if (sortKey === 'path') cmp = a.path.localeCompare(b.path)
      else cmp = a[sortKey] - b[sortKey]
      return cmp * dir
    })
  }, [projects, sortKey, sortDir, filter, language])

  // Drop selections for projects that no longer exist (deleted/filtered out).
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const valid = new Set(sortedProjects.map(p => p.id))
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (valid.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [sortedProjects])

  const selectableIds = useMemo(() => sortedProjects.map(p => p.id), [sortedProjects])
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id))
  const someSelected = !allSelected && selectableIds.some(id => selectedIds.has(id))

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelectedIds(prev => {
      if (selectableIds.length > 0 && selectableIds.every(id => prev.has(id))) {
        return new Set()
      }
      return new Set(selectableIds)
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleBatchDelete = async () => {
    const targets = sortedProjects.filter(p => selectedIds.has(p.id))
    if (targets.length === 0) return
    const ok = await confirmDialog({
      title: t('批量删除项目'),
      message: t('确定永久删除选中的 {count} 个项目？', { count: targets.length }),
      detail: t('将移除工作区记录并关闭相关终端与标签页，不会删除磁盘上的项目文件。'),
      kind: 'danger',
      confirmLabel: t('永久删除'),
      cancelLabel: t('取消'),
    })
    if (!ok) return
    for (const p of targets) {
      try {
        await useTerminalStore.getState().closeProjectTerminals(p.id)
        useEditorStore.getState().closeTabsForPath(p.path)
        useEditorStore.getState().discardProjectSession(p.id)
        await useProjectStore.getState().removeProject(p.id)
      } catch (e) {
        useProjectStore.getState().pushToast('error', t('删除「{name}」失败: {error}', { name: p.name, error: String(e) }))
      }
    }
    setSelectedIds(new Set())
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeProjectManager()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeProjectManager])

  const cycleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' || key === 'path' ? 'asc' : 'desc')
    }
  }

  const handleDelete = (project: Project) => {
    void removeProjectWithConfirm(project.id, project.name, project.path)
  }

  const handleRelocate = (project: Project) => {
    void relocateProjectWithDialog(project.id)
  }

  const handleRename = (project: Project) => {
    void renameProjectWithPrompt(project.id, project.name)
  }

  const handleActivate = async (project: Project) => {
    if (unavailableProjectIds.includes(project.id)) return
    if (project.hidden) await unhideProject(project.id)
    await switchProject(project)
    closeProjectManager()
  }

  const visibleCount = projects.filter(p => !p.hidden).length
  const hiddenCount = projects.length - visibleCount

  return (
    <ModalOverlay onDismiss={closeProjectManager}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('项目管理')}
        className="ui-font-scaled modal-content-enter relative w-full max-w-[760px] max-h-[80vh] flex flex-col rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        onPointerDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border-strong flex-shrink-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
            <Folders size={16} className="text-fg-muted" />
            {t('项目管理')}
            <span className="text-[12px] text-fg-muted font-normal">
              {t('共 {total} 个 · 显示 {visible} · 隐藏 {hidden}', { total: projects.length, visible: visibleCount, hidden: hiddenCount })}
            </span>
          </div>
          <button
            type="button"
            aria-label={t('关闭')}
            onClick={closeProjectManager}
            className="p-1 rounded text-fg-dim hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Toolbar: add buttons + filter + sort */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => void addProjectFromDialog()}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded border border-border-strong text-fg hover:bg-bg-hover transition-colors"
          >
            <FolderPlus size={13} /> {t('添加文件夹')}
          </button>
          <button
            type="button"
            onClick={() => void addTerminalProjectWithPrompt()}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded border border-border-strong text-fg hover:bg-bg-hover transition-colors"
          >
            <TerminalIcon size={13} /> {t('新建草稿项目')}
          </button>
          <button
            type="button"
            onClick={() => {
              closeProjectManager()
              openWorkspaceManager()
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded border border-border-strong text-fg hover:bg-bg-hover transition-colors"
          >
            <Layers size={13} /> {t('多项目工作区')}
          </button>

          <SegmentedControl<FilterMode>
            className="ml-auto"
            ariaLabel={t('筛选项目')}
            options={[
              { value: 'all', label: t('全部') },
              { value: 'visible', label: t('已显示') },
              { value: 'hidden', label: t('已隐藏') },
            ]}
            value={filter}
            onChange={setFilter}
          />

          <div className="flex items-center gap-1 text-[12px] text-fg-muted">
            {t('排序')}
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              className="bg-bg-active border border-border-strong rounded px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-accent"
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
                <option key={k} value={k}>
                  {t(SORT_LABELS[k])}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={t('切换排序方向')}
              onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
              className="p-1 rounded text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            >
              {sortDir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
            </button>
          </div>
        </div>

        {/* Selection action bar — only visible while rows are checked. */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border flex-shrink-0 bg-bg-active/40">
            <span className="text-[12px] text-fg-muted">{t('已选 {count} 项', { count: selectedIds.size })}</span>
            <button
              type="button"
              onClick={() => void handleBatchDelete()}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded border border-danger/40 text-danger hover:bg-danger/10 transition-colors"
            >
              <Trash2 size={13} /> {t('批量删除')}
            </button>
            <button
              type="button"
              onClick={() => void saveSelectedProjectsAsWorkspace([...selectedIds])}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded border border-border-strong text-fg hover:bg-bg-hover transition-colors"
            >
              <Layers size={13} /> {t('保存选中为多项目工作区')}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto px-2 py-1 text-[12px] rounded text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
            >
              {t('取消选择')}
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-auto">
          {sortedProjects.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-fg-muted">
              {t('暂无项目。点击上方按钮添加。')}
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-bg-elevated border-b border-border-strong text-fg-muted">
                <tr className="text-left">
                  <th className="px-3 py-1.5 w-8">
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected}
                      onChange={toggleAll}
                      ariaLabel={t('全选当前列表')}
                    />
                  </th>
                  <Th onClick={() => cycleSort('name')} active={sortKey === 'name'} dir={sortDir}>
                    {t('名称')}
                  </Th>
                  <Th onClick={() => cycleSort('path')} active={sortKey === 'path'} dir={sortDir}>
                    {t('路径')}
                  </Th>
                  <Th onClick={() => cycleSort('last_opened_at')} active={sortKey === 'last_opened_at'} dir={sortDir}>
                    {t('最近打开')}
                  </Th>
                  <th className="px-3 py-1.5 font-medium text-right">{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedProjects.map(project => {
                  const unavailable = unavailableProjectIds.includes(project.id)
                  const isCurrent = currentProject?.id === project.id
                  const checked = selectedIds.has(project.id)
                  // trustTick invalidates this read when localStorage trust changes.
                  const trustLevel = trustTick >= 0 ? getWorkspaceTrust(project) : 'undecided'
                  const trusted = trustLevel === 'trusted'
                  const restricted = trustLevel === 'restricted'
                  return (
                    <tr
                      key={project.id}
                      className={`border-b border-border/60 group ${
                        checked ? 'bg-accent/10' : isCurrent ? 'bg-bg-active/40' : 'hover:bg-bg-hover/60'
                      }`}
                    >
                      <td className="px-3 py-2 align-middle">
                        <Checkbox
                          checked={checked}
                          onChange={() => toggleOne(project.id)}
                          ariaLabel={t('选择 {name}', { name: project.name })}
                        />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <div className="flex items-center gap-1.5">
                          {unavailable ? (
                            <AlertTriangle size={13} className="text-warn flex-shrink-0" />
                          ) : project.hidden ? (
                            <EyeOff size={13} className="text-fg-dim flex-shrink-0" />
                          ) : (
                            <Folder size={13} className="text-accent flex-shrink-0" />
                          )}
                          <button
                            type="button"
                            onClick={() => void handleActivate(project)}
                            disabled={unavailable}
                            className={`truncate max-w-[160px] text-left ${
                              unavailable
                                ? 'text-fg-dim cursor-default'
                                : isCurrent
                                ? 'text-fg font-medium'
                                : 'text-fg hover:text-accent'
                            }`}
                            title={unavailable ? t('目录不可用，请重新定位') : project.name}
                          >
                            {project.name}
                            {isCurrent && (
                              <Check size={11} className="inline-block ml-1 text-accent align-middle" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <span
                          className="block truncate max-w-[260px] text-fg-muted"
                          title={project.path}
                        >
                          {project.path}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-middle whitespace-nowrap text-fg-muted text-[12px]">
                        {timeAgo(project.last_opened_at, t)}
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <div className="flex items-center justify-end gap-0.5">
                          {project.hidden ? (
                            <ActBtn label={t('恢复显示')} onClick={() => void unhideProject(project.id)}>
                              <Eye size={14} />
                            </ActBtn>
                          ) : (
                            <ActBtn label={t('从顶栏隐藏')} onClick={() => void hideProject(project.id)}>
                              <EyeOff size={14} />
                            </ActBtn>
                          )}
                          {trusted && (
                            <ActBtn
                              label={t('切换为受限模式')}
                              onClick={() => {
                                restrictProject(project)
                                void pushTrustedRootsToNative(allProjects)
                              }}
                            >
                              <ShieldAlert size={14} />
                            </ActBtn>
                          )}
                          {restricted && (
                            <ActBtn
                              label={t('信任此项目')}
                              onClick={() => {
                                trustProject(project)
                                void pushTrustedRootsToNative(allProjects)
                              }}
                            >
                              <ShieldCheck size={14} />
                            </ActBtn>
                          )}
                          {(trusted || restricted) && (
                            <ActBtn
                              label={t('清除信任决定')}
                              onClick={() => {
                                untrustProject(project)
                                void pushTrustedRootsToNative(allProjects)
                              }}
                            >
                              <ShieldOff size={14} />
                            </ActBtn>
                          )}
                          <ActBtn label={t('重命名')} onClick={() => handleRename(project)}>
                            <Pencil size={14} />
                          </ActBtn>
                          <ActBtn label={t('重新定位')} onClick={() => handleRelocate(project)}>
                            <LocateFixed size={14} />
                          </ActBtn>
                          <ActBtn label={t('永久删除')} danger onClick={() => handleDelete(project)}>
                            <Trash2 size={14} />
                          </ActBtn>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border-strong flex-shrink-0">
          <span className="text-[12px] text-fg-muted">
            {t('顶栏 ✕ 仅隐藏显示；此处「永久删除」才会清除项目记录')}
          </span>
          <button
            type="button"
            onClick={closeProjectManager}
            className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors"
          >
            {t('完成')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function Th({
  children,
  onClick,
  active,
  dir,
}: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  dir: SortDir
}) {
  return (
    <th className="px-3 py-1.5 font-medium">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-fg transition-colors ${
          active ? 'text-fg' : 'text-fg-muted'
        }`}
      >
        {children}
        {active &&
          (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  )
}

function ActBtn({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`p-1 rounded transition-colors
          ${danger
            ? 'text-fg-dim hover:text-danger'
            : 'text-fg-dim hover:text-fg hover:bg-bg-active'}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={event => {
        event.stopPropagation()
        onChange()
      }}
      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors
        ${checked || indeterminate
          ? 'bg-accent border-accent text-white'
          : 'border-border-strong text-transparent hover:border-accent'}`}
    >
      {indeterminate ? (
        <span className="block h-[2px] w-2 bg-current" />
      ) : (
        <Check size={11} className={checked ? 'text-white' : 'text-transparent'} />
      )}
    </button>
  )
}
