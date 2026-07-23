import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { X, Plus, Trash2, Wand2, CircleHelp } from 'lucide-react'
import Tooltip from './Tooltip'
import ModalOverlay from './ModalOverlay'
import { useRunConfigStore, defaultConfigs, RUN_CONFIG_RELATIVE_PATH, runConfigPath, stripRedundantCdPrefix, type RunConfig, type RunTask, type RunTaskType } from '../store/runConfigStore'
import { useEditorStore } from '../store/editorStore'
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
  const titleId = useId()
  const descriptionId = useId()
  const [name, setName] = useState(initial?.name ?? '')
  const [tasks, setTasks] = useState<RunTask[]>(initial?.tasks ?? [])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    queueMicrotask(() => {
      setName(initial?.name ?? '')
      setTasks(initial?.tasks ?? [])
    })
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
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-border flex-shrink-0">
          <h2 id={titleId} className="text-[13px] font-medium">
            {initial ? t('编辑运行配置') : t('新建运行配置')}
            <span className="text-fg-dim"> · {project.name}</span>
          </h2>
          <button
            type="button"
            aria-label={t('关闭运行配置编辑器')}
            onClick={onClose}
            className="text-fg-dim hover:text-fg p-1 rounded hover:bg-bg-hover"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label htmlFor="run-config-name" className="text-[12px] text-fg-muted w-16 flex-shrink-0">{t('名称')}</label>
            <input
              id="run-config-name"
              data-modal-autofocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('如：前后端')}
              className="flex-1 px-2 py-1 text-[13px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
            />
            <Tooltip label={t('从常见模板填充（Python 后端 + 前端）')} side="bottom">
              <button
                type="button"
                onClick={loadTemplate}
                className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded bg-bg-elevated hover:bg-bg-active border border-border text-fg-muted hover:text-fg"
              >
                <Wand2 size={13} /> {t('模板')}
              </button>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[12px] text-fg-muted">{t('任务（每个任务启动一个终端）')}</span>
            <button
              type="button"
              onClick={addTask}
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded text-accent hover:bg-bg-hover"
            >
              <Plus size={13} /> {t('添加任务')}
            </button>
          </div>

          {tasks.length === 0 ? (
            <div className="text-[12px] text-fg-dim py-3 text-center border border-dashed border-border rounded">
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

        <div className="flex items-center justify-between gap-3 px-4 h-11 border-t border-border flex-shrink-0">
          <p id={descriptionId} className="text-ui-sm truncate text-fg-dim">
            {t('保存至')}{' '}
            <button
              type="button"
              aria-label={`${t('打开文件')}: ${RUN_CONFIG_RELATIVE_PATH}`}
              onClick={() => void useEditorStore.getState().openFile(runConfigPath(project))}
              className="rounded bg-bg-deep/70 px-1 py-px font-mono text-fg-muted transition-colors hover:bg-bg-hover hover:text-accent hover:underline"
            >
              {RUN_CONFIG_RELATIVE_PATH}
            </button>
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] px-3 py-1.5 rounded text-fg-muted hover:text-fg hover:bg-bg-hover"
          >
            {t('取消')}
          </button>
          <button
            type="button"
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

  const commandHelp = t(
    'Windows 下使用 CMD，可用 && 连接命令；换行会自动转为 &&。工作目录已填时无需再写 cd。',
  )

  return (
    <div className="rounded-md border border-border bg-bg/40 p-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-fg-dim w-6 flex-shrink-0">#{index + 1}</span>
        <input
          aria-label={t('任务名')}
          value={task.name ?? ''}
          onChange={e => onChange({ name: e.target.value })}
          placeholder={t('任务名（可选，如：后端）')}
          className="flex-1 min-w-0 px-2 py-0.5 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
        />
        <select
          aria-label={t('任务类型')}
          value={task.type}
          onChange={e => onChange({ type: e.target.value as RunTaskType })}
          className="max-w-[9.5rem] px-2 py-0.5 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
        >
          {TYPE_OPTIONS.map(taskType => (
            <option key={taskType} value={taskType}>
              {t(TYPE_LABEL[taskType])}
            </option>
          ))}
        </select>
        <Tooltip label={t('删除任务')} side="bottom">
          <button
            type="button"
            aria-label={t('删除任务 {index}', { index: index + 1 })}
            onClick={onRemove}
            className="p-0.5 rounded text-fg-dim hover:text-danger hover:bg-bg-hover"
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
      {task.type === 'command' ? (
        <div className="flex items-start gap-2">
          <div className="flex items-center gap-0.5 w-16 flex-shrink-0 pt-1">
            <label className="text-[11px] text-fg-muted">{t('命令')}</label>
            <Tooltip label={commandHelp} side="bottom" wrapperClassName="inline-flex">
              <span className="text-fg-dim hover:text-fg-muted cursor-default" aria-hidden>
                <CircleHelp size={11} />
              </span>
            </Tooltip>
          </div>
          <CommandTextarea
            value={task.target}
            onChange={value => onChange({ target: value })}
            placeholder="python manage.py runserver"
            ariaLabel={t('命令')}
            className="flex-1 min-w-0"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">{t('脚本路径')}</label>
          <input
            aria-label={t('脚本路径')}
            value={task.target}
            onChange={e => onChange({ target: e.target.value })}
            placeholder="scripts/run_backend.ps1"
            className="flex-1 min-w-0 px-2 py-0.5 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">{t('工作目录')}</label>
        <input
          aria-label={t('工作目录')}
          value={task.cwd ?? ''}
          onChange={e => onChange({ cwd: e.target.value })}
          placeholder={t('留空=项目根；可相对，如 backend/')}
          className="flex-1 min-w-0 px-2 py-0.5 text-[12px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-fg-muted w-16 flex-shrink-0">{t('环境变量')}</label>
          {envEntries.length > 0 && <span className="flex-1 min-w-0" />}
          <button
            type="button"
            aria-label={t('添加环境变量')}
            onClick={() => setEnv([...envEntries, ['', '']])}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-accent hover:bg-bg-hover shrink-0"
          >
            <Plus size={11} /> {t('添加')}
          </button>
        </div>
        {envEntries.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-1.5 pl-[4.5rem]">
            <input
              aria-label={t('环境变量名称')}
              value={k}
              onChange={e =>
                setEnv(envEntries.map((entry, idx) => (idx === i ? [e.target.value, entry[1]] : entry)))
              }
              placeholder="KEY"
              className="w-28 px-1.5 py-0.5 text-[11px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
            />
            <span className="text-fg-dim">=</span>
            <input
              aria-label={t('环境变量值')}
              value={v}
              onChange={e =>
                setEnv(envEntries.map((entry, idx) => (idx === i ? [entry[0], e.target.value] : entry)))
              }
              placeholder="value"
              className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono"
            />
            <button
              type="button"
              aria-label={t('删除环境变量')}
              onClick={() => setEnv(envEntries.filter((_, idx) => idx !== i))}
              className="p-0.5 rounded text-fg-dim hover:text-danger hover:bg-bg-hover"
            >
              <X size={11} />
            </button>
          </div>
        ))}
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
  className,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  ariaLabel?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const minRows = 1
  const maxRows = 8

  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 18
    const padding = 8
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
      aria-label={ariaLabel}
      onChange={e => onChange(e.target.value)}
      onInput={resize}
      className={`w-full min-h-[1.75rem] max-h-40 px-2 py-1 text-[12px] leading-[18px] rounded bg-bg-deep border border-border focus:border-accent outline-none font-mono resize-y overflow-y-auto wrap-break-word ${className ?? ''}`}
    />
  )
}
