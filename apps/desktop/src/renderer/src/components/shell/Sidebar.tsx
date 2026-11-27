import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, Bell, Settings, Smartphone, SquarePen, Upload } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { t } from '@qn/codex-client'
import type { Project } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../lib/layout'
import { activeFirst, isThreadInProgress, threadKey } from '../../lib/threads'
import { useCodex } from '../../store/codex'
import { useProjects } from '../../store/projects'
import { sidebarTargets, useTargets } from '../../store/targets'
import { useThreadPrefs } from '../../store/threadPrefs'
import { useUi } from '../../store/ui'
import { LegacyBanner } from '../LegacyImport'
import { ResizeHandle } from '../ResizeHandle'
import { targetDisplayName } from '../targetName'
import { ErrorNote, IconButton } from '../ui'
import { ArchivedThreadsDialog } from './ArchivedThreadsDialog'
import { ProjectTree } from './ProjectTree'
import { ForceUpdateDialog, TargetPicker, TargetSectionHeader, type TargetActions } from './TargetSwitcher'

const COLLAPSED_KEY = 'qn-sidebar-collapsed-targets'
const noActivePaths = new Set<string>()

function readCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * 侧栏（参考 Codex）：新会话 → 工作区（多个目标同时铺开，每个目标下挂项目/会话树）→ 底部入口。
 * 同时操作多台远程机器时不用来回切换：点哪个目标下的项目，主区就切到那个目标。
 */
export function Sidebar({
  onImport,
  onMobile,
  onSettings,
  ...targetActions
}: TargetActions & { onImport: () => void; onMobile: () => void; onSettings: () => void }) {
  const width = useUi((s) => s.sidebarWidth)
  const setWidth = useUi((s) => s.setSidebarWidth)
  const targets = useTargets((s) => s.targets)
  const sidebarIds = useTargets((s) => s.sidebarIds)
  const selectedId = useTargets((s) => s.selectedId)
  const loaded = useTargets((s) => s.loaded)
  const loadError = useTargets((s) => s.error)
  const shown = sidebarTargets(targets, sidebarIds, selectedId)
  const [runningFirst, setRunningFirst] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const states = useTargets((s) => runningFirst ? s.states : null)
  const projectLists = useProjects((s) => runningFirst ? s.byTarget : null)
  const prefs = useThreadPrefs((s) => runningFirst ? s.byTarget : null)
  const projectPaths = useMemo(() => new Map(Object.entries(projectLists ?? {}).map(([targetId, list]) => [
    targetId, new Map(list.projects.map((project) => [project.path, project])),
  ])), [projectLists])
  const activeProjects = useCodex(useShallow(({ threadLists, sessions }) => {
    if (!runningFirst) return null
    const result = new Set<Project>()
    for (const { targetId, cwd, threads } of Object.values(threadLists)) {
      const knownPaths = projectPaths.get(targetId)
      if (!knownPaths || states?.[targetId]?.state !== 'ready') continue
      const scopedProject = cwd ? knownPaths.get(cwd) : undefined
      if (cwd && (!scopedProject || result.has(scopedProject))) continue
      for (const thread of threads) {
        const project = scopedProject ?? knownPaths.get(thread.cwd)
        if (!project || result.has(project) || prefs?.[targetId]?.hidden[threadKey(thread.agent, thread.id)]) continue
        const view = sessions[sessionKey(targetId, thread.agent)]?.state.threads[thread.id]
        if (!isThreadInProgress(thread, view)) continue
        result.add(project)
        if (scopedProject) break
      }
    }
    return result
  }))
  const activePaths = useMemo(() => {
    if (!activeProjects) return null
    const result = new Map<string, Set<string>>()
    for (const { targetId, path } of activeProjects) {
      let paths = result.get(targetId)
      if (!paths) result.set(targetId, (paths = new Set()))
      paths.add(path)
    }
    return result
  }, [activeProjects])
  const orderedTargets = activePaths ? activeFirst(shown, (target) => activePaths.has(target.id)) : shown
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggleCollapsed = (id: string) =>
    setCollapsed((list) => {
      const next = list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        // 存储不可用时只在本次运行内生效。
      }
      return next
    })
  const startDraft = useCodex((s) => s.startDraft)
  const isDraft = useCodex((s) => s.currentThreadId === null)
  const [version, setVersion] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)

  useEffect(() => {
    void window.qn?.version().then(setVersion).catch(() => undefined)
  }, [])

  return (
    <aside
      className="qn-enter relative flex shrink-0 flex-col border-r border-qn-border bg-qn-sidebar"
      style={{ width, ['--qn-enter-order' as string]: 1 }}
    >
      <div className="px-2 pt-2">
        <button
          type="button"
          className={`group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-0.5 text-[length:var(--qn-sidebar-font-size)] leading-tight outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-outline-hover ${
            isDraft ? 'bg-qn-hover text-qn-text' : 'text-qn-text/90'
          }`}
          onClick={() => startDraft()}
        >
          <SquarePen size={16} className="text-qn-muted" />
          <span className="flex-1 text-left">{t('新会话')}</span>
          <kbd className="hidden rounded-md border border-qn-border-strong px-1 font-sans text-[length:var(--qn-sidebar-list-detail-font-size)] text-qn-dim group-hover:inline">
            Ctrl N
          </kbd>
        </button>
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-0.5 text-left text-[length:var(--qn-sidebar-font-size)] leading-tight text-qn-text outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-outline-hover"
          onClick={() => setArchiveOpen(true)}
        >
          <Archive size={16} className="text-qn-muted" aria-hidden="true" />
          {t('已归档会话')}
        </button>
      </div>

      <div className="flex items-center justify-between pb-0.5 pl-4 pr-2 pt-3">
        <span className="text-[length:var(--qn-sidebar-list-font-size)] text-qn-muted">{t('工作区')}</span>
        <div className="flex items-center gap-0.5">
          <IconButton
            label={t('查看活动会话')}
            className="h-7 w-7 aria-pressed:bg-qn-active aria-pressed:text-qn-text"
            aria-pressed={runningFirst}
            onClick={() => {
              if (!runningFirst && listRef.current) listRef.current.scrollTop = 0
              setRunningFirst(!runningFirst)
            }}
          >
            <Bell size={15} aria-hidden />
          </IconButton>
          <TargetPicker {...targetActions} />
        </div>
      </div>

      <div ref={listRef} className="qn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded && !loadError && (
          <div className="space-y-1.5 px-2 py-2">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-8 animate-pulse rounded-lg bg-qn-panel" />
            ))}
          </div>
        )}
        {orderedTargets.map((target) => {
          const isCollapsed = collapsed.includes(target.id)
          return (
            <section key={target.id} aria-label={targetDisplayName(target)}>
              <TargetSectionHeader
                target={target}
                actions={targetActions}
                collapsed={isCollapsed}
                hasActiveSessions={isCollapsed && activePaths?.has(target.id)}
                onToggle={() => toggleCollapsed(target.id)}
              />
              {!isCollapsed && (
                <ProjectTree
                  target={target}
                  onSelectTarget={targetActions.onSelect}
                  activeSessionPaths={activePaths ? activePaths.get(target.id) ?? noActivePaths : undefined}
                />
              )}
            </section>
          )
        })}
        <ErrorNote message={loadError} variant="compact" className="mx-1 mt-1.5" />
      </div>
      {/* 归档列表跟随活动目标：主区当前用的是哪台机器，就看哪台的归档。 */}
      {archiveOpen && selectedId && (
        <ArchivedThreadsDialog key={selectedId} targetId={selectedId} onClose={() => setArchiveOpen(false)} />
      )}
      <ForceUpdateDialog />

      <div className="px-2 pb-1">
        <LegacyBanner />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-qn-border px-2 py-1.5">
        <div className="flex max-w-full flex-wrap gap-0.5">
          <FooterButton label={t('手机连接')} onClick={onMobile}>
            <Smartphone size={14} />
          </FooterButton>
          <FooterButton label={t('导入旧版')} onClick={onImport}>
            <Upload size={14} />
          </FooterButton>
          <FooterButton label={t('设置')} onClick={onSettings}>
            <Settings size={14} />
          </FooterButton>
        </div>
        {version && (
          <span className="ml-auto max-w-full truncate px-1 text-[length:var(--qn-sidebar-list-detail-font-size)] text-qn-dim" title={`v${version}`}>
            v{version}
          </span>
        )}
      </div>

      <ResizeHandle
        orientation="vertical"
        className="absolute inset-y-0 -right-1"
        label={t('调整侧栏宽度')}
        value={width}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        onChange={setWidth}
        onReset={() => setWidth(Number.NaN)}
      />
    </aside>
  )
}

function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 rounded-lg px-1 py-1.5 text-[length:var(--qn-sidebar-detail-font-size)] leading-tight whitespace-nowrap text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover"
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}
