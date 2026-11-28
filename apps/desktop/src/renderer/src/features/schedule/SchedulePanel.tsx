import { CalendarClock, Plus, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { t } from '@qn/codex-client'
import type {
  AgentKind, ScheduleCadence, ScheduleInput, ScheduleMethods, ScheduleRun,
  ScheduleRunReason, ScheduleRunStatus, ScheduleSummary,
} from '@qn/protocol'
import { Select } from '../../components/primitives'
import { Checkbox, IconButton, Modal } from '../../components/ui'
import { BackendCallError, call } from '../../lib/backend'
import { useCodex } from '../../store/codex'
import { useCwdUntrusted } from '../../store/projectTrust'
import { useSettings } from '../settings/settingsStore'
import { onServerEvt } from '../workspace/serverCall'

const AGENTS = { codex: 'Codex', claude: 'Claude', pi: 'pi' } satisfies Record<AgentKind, string>
const statuses: Record<ScheduleRunStatus, string> = {
  running: t('运行中'), waiting: t('等待你处理'), succeeded: t('运行成功'), failed: t('运行失败'),
  interrupted: t('已中断'), skipped: t('已跳过'), missed: t('错过触发时间'), rateLimited: t('Agent 额度已耗尽'),
}
const reasons: Record<ScheduleRunReason, string> = {
  agentUnavailable: t('Agent 无法启动'), profileChanged: t('Agent 配置已变化，请重新保存任务'),
  projectUnavailable: t('项目目录不可用，任务已暂停'), startFailed: t('无法启动定时会话'),
  permissionsUnavailable: t('Codex 未确认只读权限，提示词未发送'),
  timeout: t('运行超时'), agentExited: t('Agent 已退出'), daemonRestarted: t('目标服务已重启'),
  turnFailed: t('会话运行出错'), busy: t('目标上有另一项定时任务在运行'),
}

function scheduleCall<M extends keyof ScheduleMethods>(
  targetId: string, method: M, params: ScheduleMethods[M]['params'],
): Promise<ScheduleMethods[M]['result']> {
  return call('server.req', { targetId, method, params }) as Promise<ScheduleMethods[M]['result']>
}

function scheduleError(error: unknown): string {
  if (error instanceof BackendCallError && error.code === 'method') return t('目标服务版本过旧，请升级后使用定时任务。')
  return error instanceof Error ? t(error.message) : t('定时任务请求失败')
}

function formatTime(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', timeZone }).format(at)
}

function useScheduleData<T>(targetId: string, load: () => Promise<T>) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState('')
  const revision = useRef(0)
  const refresh = useCallback(() => {
    const latest = ++revision.current
    void load().then((result) => {
      if (revision.current !== latest) return
      setData(result)
      setError('')
    }, (err: unknown) => {
      if (revision.current === latest) setError(scheduleError(err))
    })
  }, [load])
  useEffect(() => {
    refresh()
    const unsubscribe = onServerEvt('schedule.changed', (id) => { if (id === targetId) refresh() })
    return () => {
      ++revision.current
      unsubscribe()
    }
  }, [refresh, targetId])
  return { data, error, refresh }
}

type Confirmation = { task: ScheduleSummary; action: 'runNow' | 'delete' }

export function SchedulePanel({ targetId, cwd }: { targetId: string; cwd: string }) {
  const load = useCallback(() => scheduleCall(targetId, 'schedule.list', { cwd }), [targetId, cwd])
  const { data, error, refresh } = useScheduleData(targetId, load)
  const [edit, setEdit] = useState<ScheduleSummary | 'new'>()
  const [history, setHistory] = useState<ScheduleSummary>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const untrusted = useCwdUntrusted(targetId, cwd)
  const panelBusy = data?.some((task) => task.activeRun)

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    setSaving(true)
    setActionError('')
    try {
      await action()
      refresh()
      return true
    } catch (err) {
      setActionError(scheduleError(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('定时任务')}>
      <div className="flex items-center justify-between border-b border-qn-border px-3 py-2">
        <button type="button" className="qn-button inline-flex items-center gap-1.5" disabled={untrusted || !data || !!error} onClick={() => setEdit('new')}>
          <Plus size={14} />{t('新建任务')}
        </button>
        <IconButton label={t('刷新')} onClick={refresh}><RotateCw size={14} /></IconButton>
      </div>
      <div className="qn-scroll min-h-0 flex-1 overflow-auto px-3 py-2 text-ui">
        {error && <p role="alert" className="py-2 text-qn-danger">{error}</p>}
        {actionError && !confirmation && <p role="alert" className="py-2 text-qn-danger">{actionError}</p>}
        {untrusted && <p className="py-2 text-qn-warn">{t('仅受信任的项目可以保存或运行定时任务')}</p>}
        {!data && !error && <p className="py-2 text-qn-muted">{t('正在加载定时任务…')}</p>}
        {data?.length === 0 && <p className="py-3 text-qn-muted">{t('当前项目没有定时任务')}</p>}
        {data?.map((task) => {
          const currentRun = task.activeRun ?? task.lastRun
          return (
            <article key={task.id} className="space-y-2 border-b border-qn-border py-3 first:pt-1">
              <div className="flex flex-wrap items-start justify-between gap-1">
                <h3 className="min-w-0 wrap-anywhere font-medium text-qn-text">{task.name}</h3>
                <span className="text-ui-sm text-qn-muted">{AGENTS[task.agent]}</span>
              </div>
              <p className="text-ui-sm text-qn-muted">
                {task.enabled && task.nextRunAt !== null
                  ? t('下次运行 {time}', { time: formatTime(task.nextRunAt, task.cadence.timeZone) }) : t('已暂停')}
                {task.enabled && task.nextRunAt !== null && <span className="block wrap-anywhere">{task.cadence.timeZone}</span>}
              </p>
              {currentRun && <p className="text-ui-sm text-qn-muted">{statuses[currentRun.status]}</p>}
              {task.rateLimitedUntil && <p className="text-ui-sm text-qn-warn">
                {t('额度预计于 {time} 恢复', { time: formatTime(task.rateLimitedUntil, task.cadence.timeZone) })}
              </p>}
              {task.requiresManualResume && <p className="text-ui-sm text-qn-warn">{t('确认额度恢复后，请重新启用任务。')}</p>}
              <div className="flex flex-wrap gap-1">
                <button type="button" className="qn-button-subtle" onClick={() => setHistory(task)}>{t('运行记录')}</button>
                <button type="button" className="qn-button-subtle" disabled={saving || (untrusted && !task.enabled)} onClick={() => {
                  void mutate(() => scheduleCall(targetId, 'schedule.setEnabled', { cwd, id: task.id, enabled: !task.enabled }))
                }}>{task.enabled ? t('暂停') : t('启用')}</button>
                <button type="button" className="qn-button-subtle"
                  disabled={saving || untrusted || panelBusy || !!task.rateLimitedUntil || task.requiresManualResume}
                  onClick={() => { setActionError(''); setConfirmation({ task, action: 'runNow' }) }}>
                  {t('立即运行')}
                </button>
                <button type="button" className="qn-button-subtle" disabled={saving || untrusted || !!task.activeRun}
                  onClick={() => setEdit(task)}>{t('编辑')}</button>
                <button type="button" className="qn-button-subtle" disabled={saving || !!task.activeRun}
                  onClick={() => { setActionError(''); setConfirmation({ task, action: 'delete' }) }}>
                  {t('删除')}
                </button>
              </div>
            </article>
          )
        })}
      </div>
      {edit && <ScheduleEditor task={edit === 'new' ? undefined : edit} targetId={targetId} cwd={cwd}
        onClose={() => setEdit(undefined)} onSave={async (input) => {
          await scheduleCall(targetId, 'schedule.upsert', input)
          refresh()
          setEdit(undefined)
        }} />}
      {history && <HistoryDialog targetId={targetId} cwd={cwd} task={history} close={() => setHistory(undefined)} />}
      {confirmation && <Modal title={confirmation.action === 'delete' ? t('删除定时任务') : t('立即运行')}
        onClose={saving ? undefined : () => setConfirmation(undefined)}
        footer={<div className="flex justify-end gap-2">
          <button type="button" className="qn-button-subtle" disabled={saving} onClick={() => setConfirmation(undefined)}>{t('取消')}</button>
          <button type="button" className="qn-button" disabled={saving} onClick={() => {
            void mutate(() => scheduleCall(targetId,
              confirmation.action === 'delete' ? 'schedule.delete' : 'schedule.runNow',
              { cwd, id: confirmation.task.id })).then((ok) => {
              if (!ok) return
              setConfirmation(undefined)
              if (confirmation.action === 'runNow') setHistory(confirmation.task)
            })
          }}>{confirmation.action === 'delete' ? t('删除') : t('立即运行')}</button>
        </div>}>
        <p className="text-qn-text">{confirmation.task.name}</p>
        <p className="mt-2 text-qn-muted">{confirmation.action === 'delete'
          ? t('删除会移除任务及运行记录，已有 Agent 会话仍可在项目中查看。')
          : t('本次会创建一个新会话，并消耗你的 Agent 额度。')}</p>
        {confirmation.action === 'runNow' && confirmation.task.agent === 'pi' && <p className="mt-2 text-qn-warn">{t('pi 没有逐次审批，工具按 pi 自身配置执行。')}</p>}
        {actionError && <p role="alert" className="mt-2 text-qn-danger">{actionError}</p>}
      </Modal>}
    </section>
  )
}

function ScheduleEditor({ task, targetId, cwd, onClose, onSave }: {
  task?: ScheduleSummary
  targetId: string
  cwd: string
  onClose: () => void
  onSave: (input: ScheduleInput) => Promise<void>
}) {
  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const settings = useSettings((state) => state.settings.agents[targetId])
  const agents = (Object.keys(AGENTS) as AgentKind[]).map((value) => ({
    value, label: AGENTS[value], disabled: settings?.[value]?.enabled === false,
  }))
  const [agent, setAgent] = useState<AgentKind>(task?.agent ?? agents.find((item) => !item.disabled)?.value ?? 'codex')
  const [enabled, setEnabled] = useState(task?.enabled ?? false)
  const [piAcknowledged, setPiAcknowledged] = useState(false)
  const [cadence, setCadence] = useState<ScheduleCadence>(task?.cadence ?? {
    frequency: 'weekdays', time: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekday: 1,
  })
  const [preview, setPreview] = useState<number[]>([])
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const previewReady = cadence.time && cadence.timeZone
  const canSave = !saving && !!name.trim() && !!prompt.trim() && !!previewReady &&
    !previewError && settings?.[agent]?.enabled !== false && (agent !== 'pi' || piAcknowledged)

  useEffect(() => {
    if (!previewReady) {
      setPreview([])
      setPreviewError('')
      return
    }
    let disposed = false
    const timer = setTimeout(() => {
      void scheduleCall(targetId, 'schedule.preview', { cadence }).then((dates) => {
        if (!disposed) {
          setPreview(dates)
          setPreviewError('')
        }
      }, (err: unknown) => {
        if (!disposed) {
          setPreview([])
          setPreviewError(scheduleError(err))
        }
      })
    }, 180)
    return () => { disposed = true; clearTimeout(timer) }
  }, [cadence, previewReady, targetId])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      await onSave({ id: task?.id, cwd, name, prompt, agent, cadence, enabled, piAcknowledged })
    } catch (err) {
      setError(scheduleError(err))
      setSaving(false)
    }
  }

  const weekdays = Array.from({ length: 7 }, (_, day) => ({
    value: String(day),
    label: new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 4 + day)),
  }))
  const mode = agent === 'codex' ? t('Codex 使用只读沙箱。')
    : agent === 'claude' ? t('Claude 使用计划模式。') : t('pi 没有逐次审批，工具按 pi 自身配置执行。')

  return <Modal title={task ? t('编辑定时任务') : t('新建定时任务')} onClose={saving ? undefined : onClose}
    description={t('每次运行会在目标机创建新会话，并消耗你的 Agent 额度。')}
    footer={<div className="flex justify-end gap-2">
      <button type="button" className="qn-button-subtle" disabled={saving} onClick={onClose}>{t('取消')}</button>
      <button type="submit" form="qn-schedule-form" className="qn-button" disabled={!canSave}>{t('保存')}</button>
    </div>}>
    <form id="qn-schedule-form" className="space-y-3" onSubmit={(event) => { void submit(event) }}>
      <label className="block space-y-1">
        <span>{t('任务名称')}</span>
        <input className="qn-input w-full" value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="space-y-1">
        <span>Agent</span>
        <Select value={agent} aria-label="Agent" className="w-full"
          onValueChange={(value) => { setAgent(value as AgentKind); setPiAcknowledged(false) }}
          options={agents} />
        <p className={agent === 'pi' ? 'text-qn-warn' : 'text-qn-muted'}>{mode}</p>
        {settings?.[agent]?.enabled === false && <p className="text-qn-warn">{t('目标中的 Agent 已停用')}</p>}
      </div>
      {agent === 'pi' && <Checkbox checked={piAcknowledged} onChange={setPiAcknowledged}>
        {t('我确认允许 pi 在此项目中按自身配置执行工具')}
      </Checkbox>}
      <label className="block space-y-1">
        <span>{t('提示词')}</span>
        <textarea className="qn-input min-h-24 w-full resize-y" value={prompt} maxLength={16_000} required
          onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span>{t('频率')}</span>
          <Select aria-label={t('频率')} value={cadence.frequency} className="w-full"
            options={[
              { value: 'daily', label: t('每天') }, { value: 'weekdays', label: t('工作日') }, { value: 'weekly', label: t('每周') },
            ]}
            onValueChange={(value) => setCadence({ ...cadence, frequency: value as ScheduleCadence['frequency'], weekday: cadence.weekday ?? 1 })} />
        </div>
        <label className="block space-y-1">
          <span>{t('运行时间')}</span>
          <input type="time" className="qn-input w-full" required value={cadence.time}
            onChange={(event) => setCadence({ ...cadence, time: event.target.value })} />
        </label>
      </div>
      {cadence.frequency === 'weekly' && <Select aria-label={t('星期')} value={String(cadence.weekday ?? 1)} className="w-full"
        options={weekdays} onValueChange={(day) => setCadence({ ...cadence, weekday: Number(day) })} />}
      <label className="block space-y-1">
        <span>{t('时区')}</span>
        <input className="qn-input w-full" required maxLength={100} value={cadence.timeZone} placeholder="Asia/Shanghai"
          onChange={(event) => { setPreview([]); setCadence({ ...cadence, timeZone: event.target.value }) }} />
      </label>
      {preview.length > 0 && <p className="text-ui-sm text-qn-muted">
        {t('接下来三次运行')} {preview.map((at) => formatTime(at, cadence.timeZone)).join(' · ')}
      </p>}
      <Checkbox checked={enabled} onChange={setEnabled}>{t('启用后，目标机将自动发送这段提示词')}</Checkbox>
      {(error || previewError) && <p role="alert" className="text-qn-danger">{error || previewError}</p>}
    </form>
  </Modal>
}

function HistoryDialog({ targetId, cwd, task, close }: {
  targetId: string; cwd: string; task: ScheduleSummary; close: () => void
}) {
  const load = useCallback(() => scheduleCall(targetId, 'schedule.runs', { id: task.id, cwd }), [targetId, task.id, cwd])
  const { data, error } = useScheduleData(targetId, load)
  return <Modal title={t('运行记录')} description={task.name} onClose={close}>
    {error && <p role="alert" className="text-qn-danger">{error}</p>}
    {!data && !error && <p className="text-qn-muted">{t('正在加载定时任务…')}</p>}
    {data?.length === 0 && <p className="text-qn-muted">{t('暂无运行记录')}</p>}
    <ul className="divide-y divide-qn-border">
      {data?.map((run: ScheduleRun) => <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div>
          <p className="text-qn-text">{statuses[run.status]}</p>
          <p className="text-qn-muted">
            {formatTime(run.startedAt ?? run.scheduledAt ?? run.finishedAt!)} · {AGENTS[run.agent]}
            {run.reason && <> · {reasons[run.reason]}</>}
          </p>
        </div>
        {run.threadId && <button type="button" className="qn-button-subtle inline-flex items-center gap-1.5" onClick={() => {
          close()
          void useCodex.getState().openThread(run.threadId!, run.agent)
        }}><CalendarClock size={14} />{t('打开会话')}</button>}
      </li>)}
    </ul>
  </Modal>
}
