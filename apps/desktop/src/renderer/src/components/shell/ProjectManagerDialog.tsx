import { useEffect, useState, type DragEvent } from 'react'
import { Clock, Eye, EyeOff, GripVertical, Pin, Trash2 } from 'lucide-react'
import { t } from '@qn/codex-client'
import type { Project, Target } from '../../../../shared/backendApi'
import { projectListOf, useProjects, type ProjectPlacement } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { targetDisplayName } from '../targetName'
import { EmptyState, ErrorNote, IconButton, Modal, Spinner } from '../ui'

const DRAG_TYPE = 'application/x-qingcode-manage-project'
type Drop = { id: string; placement: ProjectPlacement }

/**
 * 项目管理：集中处理侧栏里分散的项目操作。
 * 删除与隐藏写入 projects.json（手机端经网关同样不显示隐藏项目）；排序是本机显示偏好。
 */
export function ProjectManagerDialog({ onClose }: { onClose: () => void }) {
  const targets = useTargets((s) => s.targets)
  const load = useProjects((s) => s.load)

  // 侧栏未展开的目标可能还没加载项目，打开对话框时补齐。
  useEffect(() => {
    const { byTarget } = useProjects.getState()
    for (const target of targets) if (!byTarget[target.id]) void load(target.id)
  }, [targets, load])

  return (
    <Modal
      title={t('项目管理')}
      description={t('拖动调整顺序。删除只移除项目记录，不删除磁盘文件；隐藏的项目在电脑侧栏和手机端都不显示。')}
      onClose={onClose}
      width="max-w-2xl"
    >
      {targets.length === 0 ? <EmptyState>{t('暂无项目。')}</EmptyState> : (
        <div className="space-y-4">
          {targets.map((target) => <TargetProjects key={target.id} target={target} />)}
        </div>
      )}
    </Modal>
  )
}

function TargetProjects({ target }: { target: Target }) {
  const { projects, loading, error } = useProjects((s) => projectListOf(s, target.id))
  const pinned = useProjects((s) => s.pinned)
  const load = useProjects((s) => s.load)
  const move = useProjects((s) => s.move)
  const sortByRecent = useProjects((s) => s.sortByRecent)
  const name = targetDisplayName(target)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)

  const clearDrag = () => {
    setDraggedId(null)
    setDrop(null)
  }

  // 置顶组与普通组各自排序，不能跨组拖放（与侧栏规则一致）。
  const locateDrop = (event: DragEvent<HTMLLIElement>, id: string): Drop | null => {
    if (!draggedId || draggedId === id || !event.dataTransfer.types.includes(DRAG_TYPE)
      || pinned.includes(draggedId) !== pinned.includes(id)) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return { id, placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' }
  }

  return (
    <section aria-label={name}>
      <div className="flex items-center justify-between gap-2 pb-1">
        <h3 className="truncate text-ui font-medium text-qn-text" title={name}>{name}</h3>
        {projects.length > 1 && (
          <button type="button" className="qn-button-subtle shrink-0 gap-1.5" onClick={() => sortByRecent(target.id)}>
            <Clock size={14} aria-hidden="true" /> {t('按最近打开排序')}
          </button>
        )}
      </div>
      <ErrorNote message={error} onRetry={() => void load(target.id)} />
      {loading && projects.length === 0 ? <div className="py-2"><Spinner label={t('加载中…')} /></div> : (
        projects.length === 0 && !error ? <p className="py-1 text-ui text-qn-muted">{t('暂无项目。')}</p> : (
          <ul className="divide-y divide-qn-border rounded-lg border border-qn-border">
            {projects.map((project, index) => {
              const isPinned = pinned.includes(project.id)
              const previous = projects[index - 1]
              const next = projects[index + 1]
              const indicator = drop?.id === project.id ? drop.placement : null
              return (
                <li
                  key={project.id}
                  className={`relative${draggedId === project.id ? ' opacity-50' : ''}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData(DRAG_TYPE, project.id)
                    setDraggedId(project.id)
                  }}
                  onDragEnd={clearDrag}
                  onDragOver={(event) => {
                    const target = locateDrop(event, project.id)
                    if (target) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }
                    setDrop((current) => current?.id === target?.id && current?.placement === target?.placement ? current : target)
                  }}
                  onDragLeave={(event) => {
                    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                    setDrop((current) => current?.id === project.id ? null : current)
                  }}
                  onDrop={(event) => {
                    const target = locateDrop(event, project.id)
                    if (target && draggedId && event.dataTransfer.getData(DRAG_TYPE) === draggedId) {
                      event.preventDefault()
                      move(draggedId, target.id, target.placement)
                    }
                    clearDrag()
                  }}
                >
                  {indicator && (
                    <div aria-hidden className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-qn-accent ${indicator === 'before' ? 'top-0' : 'bottom-0'}`} />
                  )}
                  <ProjectManageRow
                    project={project}
                    pinned={isPinned}
                    // 拖放之外保留 Alt+↑/↓ 键盘排序，不额外占用按钮。
                    onMoveUp={previous && pinned.includes(previous.id) === isPinned ? () => move(project.id, previous.id, 'before') : undefined}
                    onMoveDown={next && pinned.includes(next.id) === isPinned ? () => move(project.id, next.id, 'after') : undefined}
                  />
                </li>
              )
            })}
          </ul>
        )
      )}
    </section>
  )
}

function ProjectManageRow({ project, pinned, onMoveUp, onMoveDown }: {
  project: Project
  pinned: boolean
  onMoveUp?: (() => void) | undefined
  onMoveDown?: (() => void) | undefined
}) {
  const hidden = project.hidden === true
  const setHidden = useProjects((s) => s.setHidden)
  const remove = useProjects((s) => s.remove)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  const confirmRemove = async () => {
    setRemoving(true)
    try {
      await remove(project.id)
    } finally {
      setRemoving(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex items-center gap-2 py-2 pl-1 pr-3">
      <span
        tabIndex={0}
        role="button"
        aria-label={t('拖动排序 {name}', { name: project.name })}
        title={t('拖动排序，或按 Alt+↑/↓')}
        className="flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-qn-dim outline-none hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover active:cursor-grabbing"
        onKeyDown={(event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key === 'ArrowUp' && onMoveUp) {
            event.preventDefault()
            onMoveUp()
          } else if (event.key === 'ArrowDown' && onMoveDown) {
            event.preventDefault()
            onMoveDown()
          }
        }}
      >
        <GripVertical size={14} aria-hidden />
      </span>
      <div className={`min-w-0 flex-1${hidden ? ' opacity-60' : ''}`}>
        <p className="flex items-center gap-1.5 truncate text-ui leading-tight text-qn-text" title={project.name}>
          {pinned && <Pin size={11} className="shrink-0 text-qn-dim" aria-label={t('已置顶')} />}
          <span className="truncate">{project.name}</span>
          {hidden && <span className="shrink-0 text-qn-muted">{t('（已隐藏）')}</span>}
        </p>
        <p className="truncate text-[length:var(--qn-project-detail-font-size)] leading-tight text-qn-muted" title={project.path}>
          {project.path}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="qn-button-subtle text-qn-danger" disabled={removing} onClick={() => void confirmRemove()}>
            {removing ? t('删除中…') : t('确认删除')}
          </button>
          <button type="button" className="qn-button-subtle" disabled={removing} onClick={() => setConfirming(false)}>
            {t('取消')}
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={hidden ? t('取消隐藏') : t('隐藏项目')} size="sm" onClick={() => void setHidden(project, !hidden)}>
            {hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          </IconButton>
          <IconButton label={t('删除项目')} size="sm" danger onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden />
          </IconButton>
        </div>
      )}
    </div>
  )
}
