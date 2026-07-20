import { useEffect, useMemo, useState } from 'react'
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
  isActiveRunTerminal,
  type RunConfig,
  type RunTask,
  type RunTaskType,
  RUN_CONFIG_RELATIVE_PATH,
} from '../store/runConfigStore'
import { useTerminalStore } from '../store/terminalStore'
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

const TASK_TYPE_LABEL: Record<RunTaskType, string> = {
  ps1: 'ps1',
  bat: 'bat',
  sh: 'sh',
  command: '命令',
  script: '脚本',
}

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
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const configsByProject = useRunConfigStore(s => s.configsByProject)
  const loadConfigs = useRunConfigStore(s => s.loadConfigs)
  const runConfig = useRunConfigStore(s => s.runConfig)
  const stopConfig = useRunConfigStore(s => s.stopConfig)
  const removeConfig = useRunConfigStore(s => s.removeConfig)
  const runningConfigs = useRunConfigStore(s => s.runningConfigs)
  const runningByTask = useRunConfigStore(s => s.runningByTask)
  const terminals = useTerminalStore(s => s.terminals)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)

  const projects = useProjectStore(s => s.projects)
  const [editing, setEditing] = useState<RunConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const [projectTrusted, setProjectTrusted] = useState(false)
  const [projectRestricted, setProjectRestricted] = useState(false)

  useEffect(() => {
    if (currentProject) void loadConfigs(currentProject)
  }, [currentProject?.id, loadConfigs, currentProject])

  useEffect(() => {
    const sync = () => {
      setProjectTrusted(currentProject ? isProjectTrusted(currentProject) : false)
      setProjectRestricted(currentProject ? isProjectRestricted(currentProject) : false)
    }
    sync()
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
    return () => window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
  }, [currentProject?.id, currentProject?.path])

  const configs = currentProject ? configsByProject[currentProject.id] ?? [] : []

  const runningTerminalsByConfig = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [configId, keys] of Object.entries(runningConfigs)) {
      const tids: string[] = []
      for (const k of keys) {
        const tid = runningByTask[k]
        if (
          tid &&
          terminals.some(t => t.id === tid && isActiveRunTerminal(t))
        ) {
          tids.push(tid)
        }
      }
      if (tids.length > 0) map.set(configId, tids)
    }
    return map
  }, [runningConfigs, runningByTask, terminals])

  if (!currentProject) {
    return (
      <div className="h-full flex flex-col bg-bg-sidebar text-fg">
        <Header title={t('运行配置')} />
        <div className="px-4 py-6 text-[13px] text-fg-muted">{t('请先选择或添加项目')}</div>
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
      <div className="px-4 pb-2 text-[11px] text-fg-dim">
        {t('配置保存在')}{' '}
        <code className="font-mono text-fg-muted">{RUN_CONFIG_RELATIVE_PATH}</code>
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

      <div className="flex-1 overflow-auto pb-3">
        {configs.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-fg-muted mb-3">{t('尚未配置运行任务')}</p>
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border-strong text-fg"
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
                className="group mx-2 my-1 rounded-md border border-border hover:border-border-strong bg-bg/40 hover:bg-bg-hover/40 transition-colors"
              >
                <div className="flex items-center gap-2 px-2 py-2">
                  <Tooltip label={running ? t('停止') : t('运行')} side="bottom">
                    <button
                      onClick={() =>
                        running
                          ? void stopConfig(config)
                          : void runConfig(currentProject, config)
                      }
                      className={`w-7 h-7 flex items-center justify-center rounded-md flex-shrink-0 transition-colors
                        ${running
                          ? 'bg-danger/15 text-danger hover:bg-danger/25'
                          : 'bg-accent/15 text-accent hover:bg-accent/25'}`}
                    >
                      {running ? <Square size={14} /> : <Play size={14} />}
                    </button>
                  </Tooltip>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate">{config.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0
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
                      <div className="text-[11px] text-fg-dim truncate mt-0.5">
                        {taskOverview(config.tasks, t)}
                      </div>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <Tooltip label={t('编辑')} side="bottom">
                      <button
                        className="p-1 rounded text-fg-dim hover:text-fg hover:bg-bg-hover"
                        onClick={() => setEditing(config)}
                      >
                        <Pencil size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('删除')} side="bottom">
                      <button
                        className="p-1 rounded text-fg-dim hover:text-danger hover:bg-bg-hover"
                        onClick={() => void removeConfig(currentProject, config.id)}
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
                            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-bg-deep text-fg-muted hover:text-fg hover:bg-bg-hover border border-border"
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
    <div className="px-4 h-9 flex items-center justify-between text-[11px] font-semibold tracking-wide text-fg-muted flex-shrink-0">
      <span className="flex items-center gap-2 min-w-0">
        <BugPlay size={13} className="flex-shrink-0" />
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
