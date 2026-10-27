import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Square,
  Pencil,
  Trash2,
  Plus,
  BugPlay,
  FileCode2,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import {
  useRunConfigStore,
  type RunConfig,
  type RunTask,
  type RunTaskType,
  RUN_CONFIG_RELATIVE_PATH,
  runConfigPath,
} from '../store/runConfigStore'
import {
  activeTerminalsForConfig,
  rehydrateRunTerminals,
  removeRunConfigs,
  runConfig,
  stopConfig,
} from '../lib/runConfigRuntime'
import { useTerminalStore } from '../store/terminalStore'
import { useEditorStore } from '../store/editorStore'
import {
  isProjectRestricted,
  isProjectTrusted,
  restrictProject,
  trustProject,
  pushTrustedRootsToNative,
  WORKSPACE_TRUST_CHANGED_EVENT,
} from '../lib/workspaceTrust'
import RunConfigEditor from './RunConfigEditor'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { confirmDialog } from '../store/confirmStore'

const TASK_TYPE_LABEL: Record<RunTaskType, string> = {
  ps1: 'ps1',
  bat: 'bat',
  sh: 'sh',
  command: '命令',
  script: '脚本',
}

const EMPTY_RUN_CONFIGS: RunConfig[] = []

function taskOverview(tasks: RunTask[], t: (source: string) => string): string {
  if (tasks.length === 0) return t('无任务')
  return tasks
    .map(task => {
      const label = task.name ? `${task.name}: ` : ''
      return `${label}${t(TASK_TYPE_LABEL[task.type])} ${task.target}`
    })
    .join(' · ')
}

export default function RunPanel() {
  const projectId = useProjectStore(s => s.currentProject?.id)
  // Selection and editor state belong to the visible project only.
  return <RunPanelContent key={projectId} />
}

function RunPanelContent() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const configsByProject = useRunConfigStore(s => s.configsByProject)
  const loadConfigs = useRunConfigStore(s => s.loadConfigs)
  const terminals = useTerminalStore(s => s.terminals)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)

  const projects = useProjectStore(s => s.projects)
  const [editing, setEditing] = useState<RunConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const [projectTrusted, setProjectTrusted] = useState(false)
  const [projectRestricted, setProjectRestricted] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState(false)
  const removingRef = useRef(false)

  useEffect(() => {
    if (!currentProject) return
    void loadConfigs(currentProject).then(configs => {
      // Recover linkage for restored task tabs (esp. pre-stamp sessions), then
      // rebuild running maps so Stop / 「运行中」 match live terminals.
      rehydrateRunTerminals(configs)
    })
  }, [currentProject?.id, loadConfigs, currentProject])

  useEffect(() => {
    const sync = () => {
      setProjectTrusted(currentProject ? isProjectTrusted(currentProject) : false)
      setProjectRestricted(currentProject ? isProjectRestricted(currentProject) : false)
    }
    sync()
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
    return () => window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
  }, [currentProject])

  const configs = useMemo(
    () =>
      currentProject
        ? (configsByProject[currentProject.id] ?? EMPTY_RUN_CONFIGS)
        : EMPTY_RUN_CONFIGS,
    [configsByProject, currentProject]
  )

  const selectedConfigs = configs.filter(config => selectedIds.has(config.id))
  const allSelected = configs.length > 0 && selectedConfigs.length === configs.length

  const toggleSelection = (id: string) => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const requestRemove = async (targets: RunConfig[]) => {
    if (!currentProject || targets.length === 0 || removingRef.current) return
    removingRef.current = true
    setRemoving(true)
    try {
      const running = targets.some(
        config => activeTerminalsForConfig(config.id, terminals).length > 0
      )
      const confirmed = await confirmDialog({
        title: t('删除运行配置？'),
        message:
          targets.length === 1
            ? t('将删除「{name}」及其任务定义。', { name: targets[0].name })
            : t('将删除选中的 {count} 个运行配置及其任务定义。', { count: targets.length }),
        detail: [
          ...(targets.length > 1 ? [targets.map(config => config.name).join('\n')] : []),
          running
            ? targets.length === 1
              ? t('该配置仍在运行。删除会先停止关联终端；随后可在短时间内撤销。')
              : t('所选配置仍在运行。删除会先停止关联终端；随后可在短时间内撤销。')
            : t('删除后可在短时间内撤销。'),
        ].join('\n\n'),
        kind: 'danger',
        confirmLabel: t('删除'),
      })
      if (!confirmed) return
      const ids = targets.map(config => config.id)
      await removeRunConfigs(currentProject, ids)
      setSelectedIds(previous => new Set([...previous].filter(id => !ids.includes(id))))
    } catch {
      // saveConfigs already reports the error; keep the selection for retry.
    } finally {
      removingRef.current = false
      setRemoving(false)
    }
  }

  const runningTerminalsByConfig = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const config of configs) {
      const tids = activeTerminalsForConfig(config.id, terminals)
      if (tids.length > 0) map.set(config.id, tids)
    }
    return map
  }, [configs, terminals])

  if (!currentProject) {
    return (
      <div className="h-full flex flex-col bg-bg-sidebar text-fg">
        <Header title={t('运行配置')} />
        <div className="px-4 py-6 text-ui text-fg-muted">{t('请先选择或添加项目')}</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <Header
        title={`${t('运行配置')} · ${currentProject.name}`}
        onAdd={() => setCreating(true)}
        trusted={projectTrusted}
        restricted={projectRestricted}
        onRestrict={() => {
          restrictProject(currentProject)
          void pushTrustedRootsToNative(projects)
        }}
        onTrust={() => {
          trustProject(currentProject)
          void pushTrustedRootsToNative(projects)
        }}
      />
      <div className="text-ui-sm px-4 pb-2 text-fg-dim">
        {t('配置保存在')}{' '}
        <button
          type="button"
          aria-label={`${t('打开文件')}: ${RUN_CONFIG_RELATIVE_PATH}`}
          onClick={() => void useEditorStore.getState().openFile(runConfigPath(currentProject))}
          className="rounded bg-bg-deep/70 px-1 py-px font-mono text-fg-muted transition-colors hover:bg-bg-hover hover:text-accent hover:underline"
        >
          {RUN_CONFIG_RELATIVE_PATH}
        </button>
        <span className="text-fg-dim">{t('（项目根目录相对路径）')}</span>
        {projectTrusted ? (
          <span className="ml-2 inline-flex items-center gap-1 text-ok">
            <ShieldCheck size={11} />
            {t('已信任此项目')}
          </span>
        ) : projectRestricted ? (
          <span className="ml-2 inline-flex items-center gap-1 text-warn">
            <ShieldOff size={11} />
            {t('受限模式：无法运行任务')}
          </span>
        ) : (
          <span className="ml-2 text-fg-dim">{t('打开项目时将询问是否信任')}</span>
        )}
      </div>

      {configs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2 text-ui-sm flex-shrink-0">
          <label className="inline-flex items-center gap-1.5 text-fg-muted">
            <input
              type="checkbox"
              aria-label={t('全选运行配置')}
              checked={allSelected}
              ref={node => {
                if (node) node.indeterminate = selectedConfigs.length > 0 && !allSelected
              }}
              disabled={removing}
              onChange={() => setSelectedIds(new Set(allSelected ? [] : configs.map(c => c.id)))}
              className="h-3.5 w-3.5 accent-accent"
            />
            {t('全选')}
          </label>
          <span className="text-fg-dim" aria-live="polite">
            {t('已选 {count} 项', { count: selectedConfigs.length })}
          </span>
          {selectedConfigs.length > 0 && (
            <>
              <button
                type="button"
                disabled={removing}
                onClick={() => void requestRemove(selectedConfigs)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-danger hover:bg-bg-hover disabled:opacity-50"
              >
                <Trash2 size={13} />
                {t('批量删除')}
              </button>
              <button
                type="button"
                disabled={removing}
                onClick={() => setSelectedIds(new Set())}
                className="rounded px-1.5 py-1 text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-50"
              >
                {t('取消选择')}
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto pb-3">
        {configs.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-ui text-fg-muted mb-3">{t('尚未配置运行任务')}</p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 text-ui px-3 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border-strong text-fg"
            >
              <Plus size={14} /> {t('新建配置')}
            </button>
          </div>
        ) : (
          configs.map(config => {
            const runningTids = runningTerminalsByConfig.get(config.id) ?? []
            const running = runningTids.length > 0
            return (
              <div
                key={config.id}
                className={`group mx-2 my-1 rounded-md border transition-colors ${
                  selectedIds.has(config.id)
                    ? 'border-accent bg-bg-active'
                    : 'border-border hover:border-border-strong bg-bg/40 hover:bg-bg-hover/40'
                }`}
              >
                <div className="flex items-center gap-2 px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('选择运行配置「{name}」', { name: config.name })}
                    checked={selectedIds.has(config.id)}
                    disabled={removing}
                    onChange={() => toggleSelection(config.id)}
                    className="h-3.5 w-3.5 flex-shrink-0 accent-accent"
                  />
                  <Tooltip label={running ? t('停止') : t('运行')} side="bottom">
                    <button
                      type="button"
                      aria-label={
                        running
                          ? t('停止「{name}」', { name: config.name })
                          : t('运行「{name}」', { name: config.name })
                      }
                      onClick={() =>
                        running ? void stopConfig(config) : void runConfig(currentProject, config)
                      }
                      className={`w-7 h-7 flex items-center justify-center rounded-md flex-shrink-0 transition-colors
                        ${
                          running
                            ? 'bg-danger/15 text-danger hover:bg-danger/25'
                            : 'bg-accent/15 text-accent hover:bg-accent/25'
                        }`}
                    >
                      {running ? <Square size={14} /> : <Play size={14} />}
                    </button>
                  </Tooltip>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-ui font-medium truncate">{config.name}</span>
                      <span
                        className={`text-ui-2xs px-1.5 py-0.5 rounded-full flex-shrink-0
                          ${running ? 'bg-ok/15 text-ok' : 'bg-bg-deep text-fg-dim'}`}
                      >
                        {running ? t('运行中 · {count}', { count: runningTids.length }) : t('空闲')}
                      </span>
                    </div>
                    <Tooltip
                      label={taskOverview(config.tasks, t)}
                      side="bottom"
                      wrapperClassName="block min-w-0 w-full"
                    >
                      <div className="text-ui-sm mt-0.5 truncate text-fg-dim">
                        {taskOverview(config.tasks, t)}
                      </div>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <Tooltip label={t('编辑')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('编辑运行配置「{name}」', { name: config.name })}
                        className="p-1 rounded text-fg-dim hover:text-fg hover:bg-bg-hover"
                        onClick={() => setEditing(config)}
                      >
                        <Pencil size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('删除')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('删除运行配置「{name}」', { name: config.name })}
                        disabled={removing}
                        className="p-1 rounded text-fg-dim hover:text-danger hover:bg-bg-hover disabled:opacity-50"
                        onClick={() => void requestRemove([config])}
                      >
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
                {running && (
                  <div className="px-2 pb-2 pt-0.5 flex flex-wrap gap-1">
                    {runningTids.map(tid => {
                      const term = terminals.find(t => t.id === tid)
                      if (!term) return null
                      return (
                        <Tooltip key={tid} label={term.cwd} side="bottom">
                          <button
                            onClick={() => setActiveTerminal(tid)}
                            className="inline-flex items-center gap-1 text-ui-xs px-1.5 py-0.5 rounded bg-bg-deep text-fg-muted hover:text-fg hover:bg-bg-hover border border-border"
                          >
                            <FileCode2 size={11} className="text-accent" />
                            <span className="truncate max-w-[160px]">{term.name}</span>
                          </button>
                        </Tooltip>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {(editing || creating) && (
        <RunConfigEditor
          project={currentProject}
          initial={editing}
          onClose={() => {
            setEditing(null)
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

function Header({
  title,
  onAdd,
  trusted,
  restricted,
  onRestrict,
  onTrust,
}: {
  title: string
  onAdd?: () => void
  trusted?: boolean
  restricted?: boolean
  onRestrict?: () => void
  onTrust?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="px-4 h-9 flex items-center justify-between text-ui-xs font-semibold tracking-wide text-fg-muted flex-shrink-0">
      <span className="flex items-center gap-2 min-w-0">
        <BugPlay size={13} className="flex-shrink-0 text-brand" />
        <span className="truncate">{title}</span>
      </span>
      <span className="flex items-center gap-0.5 flex-shrink-0">
        {trusted && onRestrict && (
          <Tooltip label={t('切换为受限模式')} side="bottom">
            <button
              type="button"
              onClick={onRestrict}
              className="text-fg-dim hover:text-warn p-1 rounded hover:bg-bg-hover"
              aria-label={t('切换为受限模式')}
            >
              <ShieldOff size={14} />
            </button>
          </Tooltip>
        )}
        {restricted && onTrust && (
          <Tooltip label={t('信任此项目')} side="bottom">
            <button
              type="button"
              onClick={onTrust}
              className="text-fg-dim hover:text-ok p-1 rounded hover:bg-bg-hover"
              aria-label={t('信任此项目')}
            >
              <ShieldCheck size={14} />
            </button>
          </Tooltip>
        )}
        {onAdd && (
          <Tooltip label={t('新建运行配置')} side="bottom">
            <button
              type="button"
              aria-label={t('新建运行配置')}
              onClick={onAdd}
              className="text-fg-dim hover:text-fg p-1 rounded hover:bg-bg-hover"
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  )
}
