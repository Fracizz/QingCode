import { useEffect, useId, useState } from 'react'
import { X } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { discoverRunTasks, importDiscoveredTasks, isDiscoveredTaskImported, type RunDiscoveryResult } from '../lib/runConfigDiscovery'
import { readRunConfigsForImport, useRunConfigStore } from '../store/runConfigStore'
import type { Project } from '../types'

const EMPTY_CONFIGS: import('../store/runConfigStore').RunConfig[] = []

export default function RunConfigDiscovery({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useI18n()
  const titleId = useId()
  const [result, setResult] = useState<RunDiscoveryResult | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [combined, setCombined] = useState(false)
  const [saving, setSaving] = useState(false)
  const configs = useRunConfigStore(state => state.configsByProject[project.id] ?? EMPTY_CONFIGS)

  useEffect(() => {
    let active = true
    void Promise.all([
      discoverRunTasks(project.path), readRunConfigsForImport(project),
    ]).then(([value, current]) => {
      if (active) {
        useRunConfigStore.setState(state => ({ configsByProject: { ...state.configsByProject, [project.id]: current } }))
        setResult(value)
      }
    }).catch(reason => {
      if (active) setError(String(reason))
    })
    return () => { active = false }
  }, [project])

  const available = result?.tasks.filter(task => !isDiscoveredTaskImported(task, configs)) ?? []
  const chosen = available.filter(task => selected.has(task.key))
  const save = async () => {
    if (!chosen.length || saving) return
    setSaving(true)
    setError('')
    try {
      // Preserve the latest manual edits/configs while discovery was open.
      const store = useRunConfigStore.getState()
      const current = await readRunConfigsForImport(project)
      const next = importDiscoveredTasks(current, chosen, combined)
      if (next !== current) await store.saveConfigs(project, next)
      onClose()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onDismiss={() => { if (!saving) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="modal-content-enter flex max-h-[85vh] w-full max-w-[680px] flex-col rounded-lg border border-border-strong bg-bg-sidebar text-fg shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h2 id={titleId} className="min-w-0 truncate text-ui font-medium">{t('发现运行配置')} · {project.name}</h2>
          <Tooltip label={t('关闭')} side="bottom">
            <button type="button" aria-label={t('关闭发现运行配置')} disabled={saving} onClick={onClose}
              className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-50"><X size={16} /></button>
          </Tooltip>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3">
          <p className="mb-3 text-ui-sm text-fg-muted">{t('发现只读取项目根目录和直属子目录的 package.json；勾选后保存，不会执行命令。')}</p>
          {error && <p role="alert" className="mb-2 break-words text-ui-sm text-danger">{error}</p>}
          {!result && !error && <p role="status" className="text-ui-sm text-fg-dim">{t('正在发现运行配置…')}</p>}
          {result && <>
            {result.tasks.length === 0 ? <p role="status" className="py-3 text-ui-sm text-fg-muted">{t('未发现可导入的 package.json scripts，请手动新建配置。')}</p> : <>
              <label className="mb-2 inline-flex items-center gap-2 text-ui-sm">
                <input type="checkbox" aria-label={t('全选发现的任务')} disabled={saving || !available.length}
                  checked={available.length > 0 && chosen.length === available.length}
                  onChange={() => setSelected(new Set(chosen.length === available.length ? [] : available.map(task => task.key)))} />
                {t('全选')}
              </label>
              <div className="flex flex-col gap-2">
                {result.tasks.map(task => {
                  const imported = isDiscoveredTaskImported(task, configs)
                  return <label key={task.key} className="flex items-start gap-2 rounded border border-border bg-bg-deep/50 p-2">
                    <input type="checkbox" aria-label={t('选择发现的任务「{name}」', { name: task.name })}
                      disabled={saving || imported} checked={imported || selected.has(task.key)} className="mt-1 shrink-0"
                      onChange={() => setSelected(previous => {
                        const next = new Set(previous)
                        if (next.has(task.key)) next.delete(task.key)
                        else next.add(task.key)
                        return next
                      })} />
                    <span className="min-w-0 flex-1 break-words text-ui-sm">
                      <span className="font-medium">{task.name}</span>
                      {imported && <span className="ml-2 text-fg-dim">{t('已导入')}</span>}
                      <code className="mt-1 block text-accent">{task.task.target}</code>
                      <span className="mt-1 block text-fg-dim">{task.source} · {t('工作目录')}: {task.task.cwd ?? '.'}</span>
                      <code className="mt-1 block whitespace-pre-wrap text-fg-muted">{task.script}</code>
                    </span>
                  </label>
                })}
              </div>
            </>}
            {result.warnings.length > 0 && <details className="mt-3 text-ui-sm text-warn">
              <summary>{t('部分文件或脚本已跳过（{count}）', { count: result.warnings.length })}</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 break-words">{result.warnings.map((warning, index) => <li key={index}>{warning.source}: {warning.message}</li>)}</ul>
            </details>}
          </>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2 text-ui-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" disabled={saving} checked={combined}
            onChange={event => setCombined(event.target.checked)} />{t('合并为一个配置（每项独立终端）')}</label>
          <div className="flex items-center gap-2">
            <button type="button" disabled={saving} onClick={onClose} className="rounded px-2 py-1 hover:bg-bg-hover">{t('取消')}</button>
            <button type="button" disabled={saving || !chosen.length} onClick={() => void save()}
              className="rounded border border-border-strong bg-bg-elevated px-3 py-1 text-accent hover:bg-bg-active disabled:opacity-50">
              {t('导入选中（{count}）', { count: chosen.length })}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
