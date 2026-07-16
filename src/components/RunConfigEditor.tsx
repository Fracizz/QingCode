import { useEffect, useState } from 'react'
import { X, Plus, Trash2, Wand2 } from 'lucide-react'
import Tooltip from './Tooltip'
import ModalOverlay from './ModalOverlay'
import { useRunConfigStore, type RunConfig, type RunTask, type RunTaskType } from '../store/runConfigStore'
import { defaultConfigs } from '../store/runConfigStore'
import type { Project } from '../types'

const TYPE_OPTIONS: RunTaskType[] = ['command', 'ps1', 'bat', 'sh', 'script']

const TYPE_LABEL: Record<RunTaskType, string> = {
  command: '命令',
  ps1: 'ps1 脚本',
  bat: 'bat 脚本',
  sh: 'sh 脚本',
  script: '脚本(按扩展名)',
}

interface Props {
  project: Project
  initial: RunConfig | null
  onClose: () => void
}

export default function RunConfigEditor({ project, initial, onClose }: Props) {
  const upsertConfig = useRunConfigStore(s => s.upsertConfig)
  const [name, setName] = useState(initial?.name ?? '')
  const [tasks, setTasks] = useState<RunTask[]>(initial?.tasks ?? [])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(initial?.name ?? '')
    setTasks(initial?.tasks ?? [])
  }, [initial])

  const addTask = () => {
    setTasks(ts => [
      ...ts,
      { id: crypto.randomUUID(), name: '', type: 'command', target: '', cwd: '', env: {} },
    ])
  }

  const updateTask = (id: string, patch: Partial<RunTask>) => {
    setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)))
  }

  const removeTask = (id: string) => {
    setTasks(ts => ts.filter(t => t.id !== id))
  }

  const loadTemplate = () => {
    const tpl = defaultConfigs()[0]
    setName(tpl.name)
    setTasks(tpl.tasks)
  }

  const handleSave = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    const cleanTasks = tasks
      .map(t => ({
        ...t,
        name: t.name?.trim() || undefined,
        target: t.target.trim(),
        cwd: t.cwd?.trim() || undefined,
        env: t.env && Object.keys(t.env).length > 0 ? t.env : undefined,
      }))
      .filter(t => t.target.length > 0)
    if (cleanTasks.length === 0) return
    const config: RunConfig = {
      id: initial?.id ?? crypto.randomUUID(),
      name: trimmedName,
      tasks: cleanTasks,
    }
    setSaving(true)
    try {
      await upsertConfig(project, config)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onDismiss={onClose}>
      <div
        className="relative w-full max-w-[560px] max-h-[85vh] flex flex-col bg-bg-sidebar border border-border-strong rounded-lg shadow-2xl shadow-black/50"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-border flex-shrink-0">
          <span className="text-[13px] font-medium">
            {initial ? '编辑运行配置' : '新建运行配置'}
            <span className="text-fg-dim"> · {project.name}</span>
          </span>
          <button
            onClick={onClose}
            className="text-fg-dim hover:text-fg p-1 rounded hover:bg-bg-hover"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-fg-muted w-16 flex-shrink-0">名称</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="如：前后端"
              className="flex-1 px-2 py-1.5 text-[13px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
            />
            <Tooltip label="从常见模板填充（Python 后端 + 前端）" side="bottom">
              <button
                onClick={loadTemplate}
                className="inline-flex items-center gap-1 text-[12px] px-2 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border text-fg-muted hover:text-fg"
              >
                <Wand2 size={13} /> 模板
              </button>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[12px] text-fg-muted">任务（每个任务启动一个终端）</span>
            <button
              onClick={addTask}
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded text-accent hover:bg-bg-hover"
            >
              <Plus size={13} /> 添加任务
            </button>
          </div>

          {tasks.length === 0 ? (
            <div className="text-[12px] text-fg-dim py-4 text-center border border-dashed border-border rounded">
              点击"添加任务"或"模板"快速开始
            </div>
          ) : (
            tasks.map((task, idx) => (
              <TaskEditor
                key={task.id}
                index={idx}
                task={task}
                onChange={patch => updateTask(task.id, patch)}
                onRemove={() => removeTask(task.id)}
              />
            ))
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 h-12 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="text-[13px] px-3 py-1.5 rounded text-fg-muted hover:text-fg hover:bg-bg-hover"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || tasks.filter(t => t.target.trim()).length === 0}
            className="text-[13px] px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-default"
          >
            保存
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function TaskEditor({
  index,
  task,
  onChange,
  onRemove,
}: {
  index: number
  task: RunTask
  onChange: (patch: Partial<RunTask>) => void
  onRemove: () => void
}) {
  const envEntries = Object.entries(task.env ?? {})

  const setEnv = (entries: [string, string][]) => {
    const env: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (k.trim()) env[k.trim()] = v
    }
    onChange({ env: Object.keys(env).length > 0 ? env : undefined })
  }

  return (
    <div className="rounded-md border border-border bg-bg/40 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-fg-dim w-6 flex-shrink-0">#{index + 1}</span>
        <input
          value={task.name ?? ''}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="任务名（可选，如：后端）"
          className="flex-1 px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
        />
        <select
          value={task.type}
          onChange={e => onChange({ type: e.target.value as RunTaskType })}
          className="px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
        >
          {TYPE_OPTIONS.map(t => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <Tooltip label="删除任务" side="bottom">
          <button
            onClick={onRemove}
            className="p-1 rounded text-fg-dim hover:text-danger hover:bg-bg-hover"
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">
          {task.type === 'command' ? '命令' : '脚本路径'}
        </label>
        <input
          value={task.target}
          onChange={e => onChange({ target: e.target.value })}
          placeholder={
            task.type === 'command'
              ? 'python manage.py runserver'
              : 'scripts/run_backend.ps1'
          }
          className="flex-1 px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">工作目录</label>
        <input
          value={task.cwd ?? ''}
          onChange={e => onChange({ cwd: e.target.value })}
          placeholder="留空=项目根；可相对，如 backend/"
          className="flex-1 px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-fg-muted">环境变量</label>
          <button
            onClick={() => setEnv([...envEntries, ['', '']])}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-accent hover:bg-bg-hover"
          >
            <Plus size={11} /> 添加
          </button>
        </div>
        {envEntries.length === 0 ? (
          <div className="text-[11px] text-fg-dim">无</div>
        ) : (
          envEntries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={k}
                onChange={e =>
                  setEnv(envEntries.map((entry, idx) => (idx === i ? [e.target.value, entry[1]] : entry)))
                }
                placeholder="KEY"
                className="w-28 px-1.5 py-1 text-[11px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
              />
              <span className="text-fg-dim">=</span>
              <input
                value={v}
                onChange={e =>
                  setEnv(envEntries.map((entry, idx) => (idx === i ? [entry[0], e.target.value] : entry)))
                }
                placeholder="value"
                className="flex-1 px-1.5 py-1 text-[11px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
              />
              <button
                onClick={() => setEnv(envEntries.filter((_, idx) => idx !== i))}
                className="p-1 rounded text-fg-dim hover:text-danger hover:bg-bg-hover"
              >
                <X size={11} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
