import { useMemo, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { t, translateMessage } from '@qn/codex-client'
import { FormField } from '../../components/FormField'
import { ErrorNote, IconButton, Modal } from '../../components/ui'
import { Select } from '../../components/primitives'
import {
  OS_LABEL,
  RUN_OS,
  RUN_TASK_TYPES,
  TASK_TYPE_LABEL,
  configToDraft,
  draftToConfig,
  emptyTaskDraft,
  validateDraft,
  type ConfigDraft,
  type RunConfig,
  type TaskDraft,
} from './runConfigModel'
import type { RunOs, RunTaskType } from './types'

const TYPE_HINT: Record<RunTaskType, string> = {
  command: t('Windows 用 cmd.exe，Linux/macOS 用 sh -lc'),
  ps1: t('PowerShell 脚本路径（优先 pwsh）'),
  bat: t('BAT/CMD 脚本路径（仅 Windows）'),
  sh: t('sh 脚本路径'),
  script: t('按扩展名选择：.ps1 / .bat / .sh / .py / .js'),
}

const typeOptions = RUN_TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABEL[type] }))
const restrictionOptions = [
  { value: 'all', label: t('全部系统') },
  ...RUN_OS.map((os) => ({ value: os, label: t('仅 {os}', { os: OS_LABEL[os] }) })),
]

/** 编辑一个运行配置；校验通过后交给 onSave（由面板经 fs.write 写回 run.json）。 */
export function RunConfigEditor({
  config,
  isNew,
  configs,
  platform,
  onSave,
  onClose,
}: {
  config: RunConfig
  isNew: boolean
  /** 当前文件里的全部配置，用于重名检查 */
  configs: RunConfig[]
  platform: RunOs | null
  onSave: (config: RunConfig) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ConfigDraft>(() => configToDraft(config))
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const errors = useMemo(() => validateDraft(draft, configs), [draft, configs])

  const updateTask = (index: number, patch: Partial<TaskDraft>): void =>
    setDraft((d) => ({ ...d, tasks: d.tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)) }))

  const removeTask = (index: number): void =>
    setDraft((d) => ({ ...d, tasks: d.tasks.filter((_, i) => i !== index) }))

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (errors.length > 0 || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(draftToConfig(draft))
      onClose()
    } catch (err) {
      setSaveError(translateMessage(err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={isNew ? t('新建运行配置') : t('编辑运行配置')}
      description={t('保存到项目的 .qingcode/run.json；只有点击启动才会执行命令。')}
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui-sm text-qn-danger">
            {touched && errors.length > 0 ? errors[0] : ''}
          </span>
          <button type="button" className="qn-button-subtle" onClick={onClose}>
            {t('取消')}
          </button>
          <button type="button" className="qn-button" disabled={saving || (touched && errors.length > 0)} onClick={() => void submit()}>
            {saving ? t('保存中…') : t('保存')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <ErrorNote message={saveError} onClose={() => setSaveError(null)} />
        <FormField label={t('名称')}>
          {(control) => (
            <input
              {...control}
              autoFocus
              className="qn-input"
              value={draft.name}
              placeholder={t('例如：前后端')}
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
            />
          )}
        </FormField>

        <div className="flex items-center justify-between">
          <span className="text-ui-sm text-qn-muted">{t('任务（同时启动）')}</span>
          <button
            type="button"
            className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-ui-sm"
            onClick={() => setDraft((d) => ({ ...d, tasks: [...d.tasks, emptyTaskDraft()] }))}
          >
            <Plus size={13} /> {t('添加任务')}
          </button>
        </div>

        {draft.tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            index={index}
            platform={platform}
            canRemove={draft.tasks.length > 1}
            onChange={(patch) => updateTask(index, patch)}
            onRemove={() => removeTask(index)}
          />
        ))}

        {touched && errors.length > 1 && (
          <ul className="list-disc pl-5 text-ui-sm leading-5 text-qn-danger">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

function TaskCard({
  task,
  index,
  platform,
  canRemove,
  onChange,
  onRemove,
}: {
  task: TaskDraft
  index: number
  platform: RunOs | null
  canRemove: boolean
  onChange: (patch: Partial<TaskDraft>) => void
  onRemove: () => void
}) {
  const overrideOs = Object.keys(task.overrides ?? {}) as RunOs[]
  const offPlatform = platform && task.restriction !== 'all' && task.restriction !== platform
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-qn-border bg-qn-bg/40 p-3">
      <div className="flex items-center gap-2">
        <input
          className="qn-input min-w-0 flex-1"
          value={task.name}
          placeholder={t('任务 {index} 名称（可选）', { index: index + 1 })}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Select
          aria-label={t('任务类型')}
          className="w-36"
          value={task.type}
          options={typeOptions}
          onValueChange={(value) => onChange({ type: value as RunTaskType })}
        />
        <IconButton label={t('删除任务')} size="sm" danger disabled={!canRemove} onClick={onRemove}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <FormField label={task.type === 'command' ? t('命令') : t('脚本路径')} hint={TYPE_HINT[task.type]}>
        {(control) => (
          <input
            {...control}
            className="qn-input font-mono text-ui-sm"
            value={task.target}
            placeholder={task.type === 'command' ? 'pnpm dev' : 'scripts/start.ps1'}
            spellCheck={false}
            onChange={(event) => onChange({ target: event.target.value })}
          />
        )}
      </FormField>
      <div className="flex gap-2">
        <FormField label={t('工作目录')} className="flex-1">
          {(control) => (
            <input
              {...control}
              className="qn-input font-mono text-ui-sm"
              value={task.cwd}
              placeholder={t('相对项目根，留空为项目根')}
              spellCheck={false}
              onChange={(event) => onChange({ cwd: event.target.value })}
            />
          )}
        </FormField>
        <label className="flex w-40 flex-col gap-1">
          <span className="text-ui-sm text-qn-muted">{t('系统限制')}</span>
          <Select
            aria-label={t('系统限制')}
            value={task.restriction}
            options={restrictionOptions}
            disabled={overrideOs.length > 0}
            onValueChange={(value) => onChange({ restriction: value as RunOs | 'all' })}
          />
        </label>
      </div>
      {offPlatform && (
        <div className="text-ui-sm text-qn-warn">{t('当前目标是 {os}，此任务不会在这里运行。', { os: OS_LABEL[platform] })}</div>
      )}
      {overrideOs.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-qn-fg/[0.04] px-2 py-1.5 text-ui-sm text-qn-muted">
          <span className="min-w-0 flex-1">
            {t('含按系统覆盖（{list}），保存时原样保留。', { list: overrideOs.map((os) => OS_LABEL[os]).join(t('、')) })}
          </span>
          <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => onChange({ overrides: undefined })}>
            {t('清除覆盖')}
          </button>
        </div>
      )}
      <EnvTable rows={task.env} onChange={(env) => onChange({ env })} />
    </div>
  )
}

function EnvTable({ rows, onChange }: { rows: TaskDraft['env']; onChange: (rows: TaskDraft['env']) => void }) {
  const update = (index: number, patch: Partial<TaskDraft['env'][number]>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-ui-sm text-qn-muted">{t('环境变量')}</span>
        <button
          type="button"
          className="flex items-center gap-1 text-ui-sm text-qn-muted hover:text-qn-text"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        >
          <Plus size={12} /> {t('添加')}
        </button>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            className="qn-input h-7 w-40 py-0 font-mono text-ui-sm"
            value={row.key}
            placeholder={t('名称')}
            spellCheck={false}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <span className="text-qn-dim">=</span>
          <input
            className="qn-input h-7 min-w-0 flex-1 py-0 font-mono text-ui-sm"
            value={row.value}
            placeholder={t('值')}
            spellCheck={false}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <IconButton label={t('删除变量')} size="sm" tooltip={false} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            <X size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
