import { useEffect, useMemo, useState } from 'react'
import {
  Play,
  Square,
  Pencil,
  Trash2,
  Plus,
  BugPlay,
  FileCode2,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useRunConfigStore, type RunConfig, type RunTask, type RunTaskType, RUN_CONFIG_RELATIVE_PATH } from '../store/runConfigStore'
import { useTerminalStore } from '../store/terminalStore'
import RunConfigEditor from './RunConfigEditor'
import Tooltip from './Tooltip'

const TASK_TYPE_LABEL: Record<RunTaskType, string> = {
  ps1: 'ps1',
  bat: 'bat',
  sh: 'sh',
  command: '命令',
  script: '脚本',
}

function taskOverview(tasks: RunTask[]): string {
  if (tasks.length === 0) return '无任务'
  return tasks
    .map(t => {
      const label = t.name ? `${t.name}: ` : ''
      return `${label}${TASK_TYPE_LABEL[t.type]} ${t.target}`
    })
    .join(' · ')
}

export default function RunPanel() {
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

  const [editing, setEditing] = useState<RunConfig | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (currentProject) void loadConfigs(currentProject)
  }, [currentProject?.id, loadConfigs, currentProject])

  const configs = currentProject ? configsByProject[currentProject.id] ?? [] : []

  const runningTerminalsByConfig = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [configId, keys] of Object.entries(runningConfigs)) {
      const tids: string[] = []
      for (const k of keys) {
        const tid = runningByTask[k]
        if (tid && terminals.some(t => t.id === tid && t.status !== 'exited')) tids.push(tid)
      }
      if (tids.length > 0) map.set(configId, tids)
    }
    return map
  }, [runningConfigs, runningByTask, terminals])

  if (!currentProject) {
    return (
      <div className="h-full flex flex-col bg-bg-sidebar text-fg">
        <Header title="运行配置" />
        <div className="px-4 py-6 text-[13px] text-fg-muted">请先选择或添加项目</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <Header title={`运行配置 · ${currentProject.name}`} onAdd={() => setCreating(true)} />
      <div className="px-4 pb-2 text-[11px] text-fg-dim">
        配置保存在{' '}
        <code className="font-mono text-fg-muted">{RUN_CONFIG_RELATIVE_PATH}</code>
        <span className="text-fg-dim">（项目根目录相对路径）</span>
      </div>

      <div className="flex-1 overflow-auto pb-3">
        {configs.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-fg-muted mb-3">尚未配置运行任务</p>
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border-strong text-fg"
            >
              <Plus size={14} /> 新建配置
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
                  <Tooltip label={running ? '停止' : '运行'} side="bottom">
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
                        {running ? `运行中 · ${runningTids.length}` : '空闲'}
                      </span>
                    </div>
                    <Tooltip
                      label={taskOverview(config.tasks)}
                      side="bottom"
                      wrapperClassName="block min-w-0 w-full"
                    >
                      <div className="text-[11px] text-fg-dim truncate mt-0.5">
                        {taskOverview(config.tasks)}
                      </div>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip label="编辑" side="bottom">
                      <button
                        className="p-1 rounded text-fg-dim hover:text-fg hover:bg-bg-hover"
                        onClick={() => setEditing(config)}
                      >
                        <Pencil size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label="删除" side="bottom">
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

function Header({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div className="px-4 h-9 flex items-center justify-between text-[11px] font-semibold tracking-wide text-fg-muted flex-shrink-0">
      <span className="flex items-center gap-2 min-w-0">
        <BugPlay size={13} className="flex-shrink-0" />
        <span className="truncate">{title}</span>
      </span>
      {onAdd && (
        <Tooltip label="新建运行配置" side="bottom">
          <button
            onClick={onAdd}
            className="text-fg-dim hover:text-fg p-1 rounded hover:bg-bg-hover flex-shrink-0"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
