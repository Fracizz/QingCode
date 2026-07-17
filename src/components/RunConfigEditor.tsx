import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X, Plus, Trash2, Wand2 } from 'lucide-react'
import Tooltip from './Tooltip'
import ModalOverlay from './ModalOverlay'
import { useRunConfigStore, defaultConfigs, RUN_CONFIG_RELATIVE_PATH, stripRedundantCdPrefix, type RunConfig, type RunTask, type RunTaskType } from '../store/runConfigStore'
import type { Project } from '../types'
import { useI18n } from '../lib/i18n'

const TYPE_OPTIONS: RunTaskType[] = ['command', 'ps1', 'bat', 'sh', 'script']

const TYPE_LABEL: Record<RunTaskType, string> = {
  command: '命令（CMD）',
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
  const { t } = useI18n()
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
      .map(t => {
        const cwd = t.cwd?.trim() || undefined
        const targetRaw = t.target.trim()
        const normalized =
          t.type === 'command' ? normalizeCommandTarget(targetRaw) : targetRaw
        const target =
          t.type === 'command' && cwd ? stripRedundantCdPrefix(normalized) : normalized
        return {
          ...t,
          name: t.name?.trim() || undefined,
          target,
          cwd,
          env: t.env && Object.keys(t.env).length > 0 ? t.env : undefined,
        }
      })
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
        className="modal-content-enter relative w-full max-w-[640px] max-h-[85vh] flex flex-col bg-bg-sidebar border border-border-strong rounded-lg shadow-2xl shadow-black/50"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-border flex-shrink-0">
          <span className="text-[13px] font-medium">
            {initial ? t('编辑运行配置') : t('新建运行配置')}
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
            <label className="text-[12px] text-fg-muted w-16 flex-shrink-0">{t('名称')}</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('如：前后端')}
              className="flex-1 px-2 py-1.5 text-[13px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
            />
            <Tooltip label={t('从常见模板填充（Python 后端 + 前端）')} side="bottom">
              <button
                onClick={loadTemplate}
                className="inline-flex items-center gap-1 text-[12px] px-2 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border text-fg-muted hover:text-fg"
              >
                <Wand2 size={13} /> {t('模板')}
              </button>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[12px] text-fg-muted">{t('任务（每个任务启动一个终端）')}</span>
            <button
              onClick={addTask}
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded text-accent hover:bg-bg-hover"
            >
              <Plus size={13} /> {t('添加任务')}
            </button>
          </div>

          {tasks.length === 0 ? (
            <div className="text-[12px] text-fg-dim py-4 text-center border border-dashed border-border rounded">
              {t('点击“添加任务”或“模板”快速开始')}
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

        <div className="flex items-center justify-between gap-3 px-4 h-12 border-t border-border flex-shrink-0">
          <p className="text-[11px] text-fg-dim truncate">
            {t('保存至')}{' '}
            <code className="font-mono text-fg-muted">{RUN_CONFIG_RELATIVE_PATH}</code>
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="text-[13px] px-3 py-1.5 rounded text-fg-muted hover:text-fg hover:bg-bg-hover"
          >
            {t('取消')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || tasks.filter(t => t.target.trim()).length === 0}
            className="text-[13px] px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-default"
          >
            {t('保存')}
          </button>
          </div>
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
  const { t } = useI18n()
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
          placeholder={t('任务名（可选，如：后端）')}
          className="flex-1 px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
        />
        <select
          value={task.type}
          onChange={e => onChange({ type: e.target.value as RunTaskType })}
          className="px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
        >
          {TYPE_OPTIONS.map(taskType => (
            <option key={taskType} value={taskType}>
              {t(TYPE_LABEL[taskType])}
            </option>
          ))}
        </select>
        <Tooltip label={t('删除任务')} side="bottom">
          <button
            onClick={onRemove}
            className="p-1 rounded text-fg-dim hover:text-danger hover:bg-bg-hover"
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
      {task.type === 'command' ? (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-fg-muted">{t('命令')}</label>
          <CommandTextarea
            value={task.target}
            onChange={value => onChange({ target: value })}
            placeholder="python manage.py runserver"
          />
          <p className="text-[11px] text-fg-dim">
            {t('Windows 下使用 CMD，可用 && 连接命令；换行会自动转为 &&。工作目录已填时无需再写 cd。')}
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">{t('脚本路径')}</label>
          <input
            value={task.target}
            onChange={e => onChange({ target: e.target.value })}
            placeholder="scripts/run_backend.ps1"
            className="flex-1 px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">{t('工作目录')}</label>
        <input
          value={task.cwd ?? ''}
          onChange={e => onChange({ cwd: e.target.value })}
          placeholder={t('留空=项目根；可相对，如 backend/')}
          className="flex-1 px-2 py-1 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-fg-muted">{t('环境变量')}</label>
          <button
            onClick={() => setEnv([...envEntries, ['', '']])}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-accent hover:bg-bg-hover"
          >
            <Plus size={11} /> {t('添加')}
          </button>
        </div>
        {envEntries.length === 0 ? (
          <div className="text-[11px] text-fg-dim">{t('无')}</div>
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

function normalizeCommandTarget(target: string): string {
  return target.replace(/\r\n/g, '\n').replace(/\s*\n+\s*/g, ' && ').trim()
}

function CommandTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const minRows = 2
  const maxRows = 8

  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20
    const padding = 12
    const maxHeight = lineHeight * maxRows + padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }

  useLayoutEffect(() => {
    resize()
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      rows={minRows}
      spellCheck={false}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onInput={resize}
      className="w-full min-h-[3.25rem] max-h-40 px-2.5 py-1.5 text-[12px] leading-5 rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono resize-y overflow-y-auto wrap-break-word"
    />
  )
}
