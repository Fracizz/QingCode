import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowDownToLine,
  Copy,
  CopyPlus,
  Eraser,
  FileJson,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { t, translateMessage } from '@qn/codex-client'
import { Badge, Checkbox, EmptyState, ErrorNote, IconButton, Modal, Spinner } from '../../components/ui'
import { FeedbackRow } from '../../components/FeedbackRow'
import { RefreshIcon } from '../../components/LoadingIcon'
import { Tip } from '../../components/primitives'
import { StatusDot } from '../../components/StatusDot'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { openFile } from '../workspace/openers'
import { styleToCss } from './ansi'
import { outputText, type OutputSegment } from './outputModel'
import { RunConfigEditor } from './RunConfigEditor'
import { discoverProject, type DiscoveryResult } from './runConfigIo'
import {
  RUN_CONFIG_RELATIVE_PATH,
  configTasksFor,
  createConfig,
  duplicateConfig,
  importDiscovered,
  isDiscoveredImported,
  removeConfig,
  runConfigPaths,
  runKey,
  taskLabel,
  taskOverview,
  upsertConfig,
  type RunConfig,
} from './runConfigModel'
import { useRun, useRunStore, waitForRunsExit } from './runStore'
import { configStatus, isRunning, runStatusText, runTabs, runsForConfig, type ConfigStatus } from './runView'
import type { RunInfo, RunOs } from './types'

const statusDot: Record<ConfigStatus, string> = {
  running: 'bg-qn-ok ring-3 ring-qn-fg/15',
  failed: 'bg-qn-danger',
  ok: 'bg-qn-dim',
  idle: 'bg-qn-border-strong',
}

const statusLabel: Record<ConfigStatus, string> = {
  running: t('运行中'),
  failed: t('上次运行失败'),
  ok: t('上次运行已结束'),
  idle: t('未运行'),
}

/** 目标系统未知时（run.list 失败）按路径形态猜，只用于自动发现里选 python 命令。 */
const guessOs = (cwd: string): RunOs => (/^[A-Za-z]:/.test(cwd) ? 'windows' : 'linux')

/** 运行配置面板：配置列表 + 自动发现 + 输出。props 与 GitPanel 一致。 */
export function RunPanel({ targetId, cwd }: { targetId: string; cwd: string }) {
  const view = useRun(targetId, cwd)
  const init = useRunStore((s) => s.init)
  const loadConfigs = useRunStore((s) => s.loadConfigs)
  const saveConfigs = useRunStore((s) => s.saveConfigs)
  const startRun = useRunStore((s) => s.start)
  const stopRun = useRunStore((s) => s.stop)

  const [editing, setEditing] = useState<{ config: RunConfig; isNew: boolean } | null>(null)
  const [deleting, setDeleting] = useState<RunConfig | null>(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, true>>({})

  useEffect(() => {
    void init(targetId)
    void loadConfigs(targetId, cwd)
  }, [targetId, cwd, init, loadConfigs])

  const configs = view.configs ?? []
  const canEdit = view.configs !== null && !view.configError && !view.saving
  const tabs = useMemo(() => runTabs(view.runs, view.hidden), [view.runs, view.hidden])
  const active = tabs.find((run) => run.runId === activeRunId) ?? tabs[tabs.length - 1] ?? null

  const setBusyFor = (id: string, on: boolean): void =>
    setBusy((b) => {
      const next = { ...b }
      if (on) next[id] = true
      else delete next[id]
      return next
    })

  const persist = async (next: RunConfig[]): Promise<void> => {
    await saveConfigs(targetId, cwd, next)
  }

  const startConfig = async (config: RunConfig): Promise<void> => {
    const platform = view.platform
    if (!platform) {
      setError(view.runsError ?? t('尚未取得目标系统信息，请稍后重试'))
      return
    }
    const { runnable, skipped } = configTasksFor(config, platform)
    setNotice(skipped.length > 0 ? t('已跳过：{reasons}', { reasons: skipped.map((item) => item.reason).join(t('；')) }) : null)
    if (runnable.length === 0) return
    let first: string | null = null
    for (const { task, start } of runnable) {
      try {
        const runId = await startRun(targetId, {
          cwd,
          task: start,
          label: taskLabel(config, task),
          key: runKey(config.id, task.id),
        })
        first ??= runId
      } catch (err) {
        setError(t('启动「{name}」失败：{error}', { name: taskLabel(config, task), error: translateMessage(err instanceof Error ? err.message : String(err)) }))
      }
    }
    if (first) setActiveRunId(first)
  }

  const runningOf = (config: RunConfig): RunInfo[] => runsForConfig(config, view.runs).filter(isRunning)

  const stopConfig = async (config: RunConfig): Promise<string[]> => {
    const running = runningOf(config)
    await Promise.all(
      running.map((run) =>
        stopRun(targetId, run.runId).catch((err: unknown) => {
          setError(t('停止失败：{error}', { error: translateMessage(err instanceof Error ? err.message : String(err)) }))
        }),
      ),
    )
    return running.map((run) => run.runId)
  }

  const act = async (config: RunConfig, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    if (busy[config.id]) return
    setBusyFor(config.id, true)
    setError(null)
    try {
      if (action === 'start') await startConfig(config)
      else if (action === 'stop') await stopConfig(config)
      else {
        const stopped = await stopConfig(config)
        if (stopped.length > 0 && !(await waitForRunsExit(targetId, stopped))) {
          setError(t('等待旧进程退出超时，未重新启动'))
          return
        }
        await startConfig(config)
      }
    } finally {
      setBusyFor(config.id, false)
    }
  }

  const saveEdited = async (config: RunConfig): Promise<void> => {
    await persist(upsertConfig(configs, config))
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleting
    if (!target) return
    setDeleting(null)
    try {
      await stopConfig(target)
      await persist(removeConfig(configs, target.id))
    } catch (err) {
      setError(translateMessage(err instanceof Error ? err.message : String(err)))
    }
  }

  const duplicate = async (config: RunConfig): Promise<void> => {
    try {
      await persist([...configs, duplicateConfig(configs, config)])
    } catch (err) {
      setError(translateMessage(err instanceof Error ? err.message : String(err)))
    }
  }

  const paths = runConfigPaths(cwd)

  return (
    <div className="flex h-full min-h-0 flex-col bg-qn-panel text-qn-text">
      <div className="flex shrink-0 items-center gap-1 border-b border-qn-border px-2 py-2">
        <span className="px-1 text-ui-sm font-medium">{t('运行')}</span>
        {view.platform && <Badge>{view.platform}</Badge>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label={t('新建配置')}
            className="h-7 w-7"
            disabled={!canEdit}
            onClick={() => setEditing({ config: createConfig(configs), isNew: true })}
          >
            <Plus size={14} />
          </IconButton>
          <IconButton
            label={t('从项目中发现')}
            className="h-7 w-7"
            disabled={!canEdit}
            onClick={() => setDiscoverOpen((open) => !open)}
          >
            <Search size={14} />
          </IconButton>
          <IconButton
            label={t('打开 {path}', { path: RUN_CONFIG_RELATIVE_PATH })}
            className="h-7 w-7"
            disabled={view.configSource === 'none' || view.configSource === null}
            onClick={() =>
              openFile({ targetId, path: view.configSource === 'nestcode' ? paths.legacyFile : paths.file })
            }
          >
            <FileJson size={14} />
          </IconButton>
          <IconButton
            label={t('刷新')}
            className="h-7 w-7"
            onClick={() => {
              void init(targetId)
              void loadConfigs(targetId, cwd)
            }}
          >
            <RefreshIcon loading={view.configLoading} />
          </IconButton>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-2 empty:hidden [&>*:first-child]:mt-2">
        <ErrorNote message={view.runsError} onRetry={() => void init(targetId)} />
        <ErrorNote message={view.configError} onRetry={() => void loadConfigs(targetId, cwd)} />
        <ErrorNote message={error} onClose={() => setError(null)} />
        <FeedbackRow
          message={notice}
          className="rounded-lg bg-qn-warn/10 px-3 py-2 text-ui-sm leading-5 text-qn-warn"
          onClose={() => setNotice(null)}
        />
        {view.configSource === 'nestcode' && !view.configError && (
          <div className="rounded-lg bg-qn-fg/[0.04] px-3 py-2 text-ui-sm leading-5 text-qn-muted">
            {t('读取自旧版位置 .nestcode/run.json；保存后写入 {path}。', { path: RUN_CONFIG_RELATIVE_PATH })}
          </div>
        )}
      </div>

      <div className="qn-scroll max-h-[45%] shrink-0 overflow-y-auto border-b border-qn-border p-1">
        {view.configs === null && view.configLoading ? (
          <div className="px-3 py-4">
            <Spinner label={t('读取运行配置…')} />
          </div>
        ) : configs.length === 0 && !discoverOpen ? (
          <EmptyState>
            {t('还没有运行配置。')}
            <div className="mt-2 flex justify-center gap-2">
              <button
                type="button"
                className="qn-button-subtle px-2 py-1 text-ui-sm"
                disabled={!canEdit}
                onClick={() => setEditing({ config: createConfig(configs), isNew: true })}
              >
                {t('新建配置')}
              </button>
              <button
                type="button"
                className="qn-button-subtle px-2 py-1 text-ui-sm"
                disabled={!canEdit}
                onClick={() => setDiscoverOpen(true)}
              >
                {t('从项目中发现')}
              </button>
            </div>
          </EmptyState>
        ) : (
          configs.map((config) => {
            const status = configStatus(config, view.runs, view.stopped)
            const running = status === 'running'
            const isBusy = Boolean(busy[config.id])
            return (
              <div
                key={config.id}
                className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-qn-hover"
                onDoubleClick={() => canEdit && setEditing({ config, isNew: false })}
              >
                <Tip label={statusLabel[status]}>
                  <StatusDot className={cn('size-2', statusDot[status])} />
                </Tip>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui">{config.name || t('（未命名）')}</div>
                  <div className="truncate font-mono text-ui-xs text-qn-dim" title={taskOverview(config)}>
                    {taskOverview(config)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center">
                  {running ? (
                    <IconButton label={t('停止')} size="sm" danger disabled={isBusy} onClick={() => void act(config, 'stop')}>
                      <Square size={13} />
                    </IconButton>
                  ) : (
                    <IconButton label={t('启动')} size="sm" disabled={isBusy || !view.platform} onClick={() => void act(config, 'start')}>
                      <Play size={13} />
                    </IconButton>
                  )}
                  <IconButton label={t('重启')} size="sm" disabled={isBusy || !view.platform} onClick={() => void act(config, 'restart')}>
                    <RotateCcw size={13} />
                  </IconButton>
                  <div className="flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton label={t('编辑')} size="sm" disabled={!canEdit} onClick={() => setEditing({ config, isNew: false })}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton label={t('复制配置')} size="sm" disabled={!canEdit} onClick={() => void duplicate(config)}>
                      <CopyPlus size={13} />
                    </IconButton>
                    <IconButton label={t('删除')} size="sm" danger disabled={!canEdit} onClick={() => setDeleting(config)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
              </div>
            )
          })
        )}
        {discoverOpen && (
          <DiscoveryPanel
            targetId={targetId}
            cwd={cwd}
            os={view.platform ?? guessOs(cwd)}
            configs={configs}
            disabled={!canEdit}
            onClose={() => setDiscoverOpen(false)}
            onImport={async (next) => {
              await persist(next)
              setDiscoverOpen(false)
            }}
          />
        )}
      </div>

      <RunOutputArea
        targetId={targetId}
        tabs={tabs}
        active={active}
        stopped={view.stopped}
        onSelect={setActiveRunId}
        onStop={(runId) => void stopRun(targetId, runId).catch((err: unknown) => setError(String(err)))}
      />

      {editing && (
        <RunConfigEditor
          config={editing.config}
          isNew={editing.isNew}
          configs={configs}
          platform={view.platform}
          onSave={saveEdited}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <Modal
          title={t('删除运行配置「{name}」？', { name: deleting.name })}
          description={
            runningOf(deleting).length > 0
              ? t('该配置有任务正在运行，删除时会先停止它们。')
              : t('将从 {path} 中移除，不可撤销。', { path: RUN_CONFIG_RELATIVE_PATH })
          }
          onClose={() => setDeleting(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={() => setDeleting(null)}>
                {t('取消')}
              </button>
              <button type="button" className="qn-button flex items-center gap-1" onClick={() => void confirmDelete()}>
                <Trash2 size={14} /> {t('删除')}
              </button>
            </div>
          }
        >
          <pre className="whitespace-pre-wrap font-mono text-ui-sm leading-5 text-qn-muted">{taskOverview(deleting)}</pre>
        </Modal>
      )}
    </div>
  )
}

function DiscoveryPanel({
  targetId,
  cwd,
  os,
  configs,
  disabled,
  onClose,
  onImport,
}: {
  targetId: string
  cwd: string
  os: RunOs
  configs: RunConfig[]
  disabled: boolean
  onClose: () => void
  onImport: (configs: RunConfig[]) => Promise<void>
}) {
  const [result, setResult] = useState<DiscoveryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [combined, setCombined] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    discoverProject(targetId, cwd, os)
      .then((found) => {
        if (!cancelled) setResult(found)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(translateMessage(err instanceof Error ? err.message : String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [targetId, cwd, os])

  const tasks = result?.tasks ?? []
  const chosen = tasks.filter((task) => selected.has(task.key) && !isDiscoveredImported(task, configs))

  const toggle = (key: string, on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const submit = async (): Promise<void> => {
    if (chosen.length === 0 || saving) return
    setSaving(true)
    setError(null)
    try {
      await onImport(importDiscovered(configs, chosen, combined))
    } catch (err) {
      setError(translateMessage(err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-qn-border bg-qn-bg/50 p-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-ui-sm text-qn-muted">{t('从项目中发现（只生成建议，确认后才写入）')}</span>
        <IconButton label={t('关闭')} size="sm" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <ErrorNote message={error} onClose={() => setError(null)} />
      {loading ? (
        <Spinner label={t('正在扫描 package.json、Makefile、Cargo.toml、pyproject…')} />
      ) : tasks.length === 0 ? (
        <div className="px-1 py-2 text-ui-sm text-qn-dim">{t('没有发现可用的脚本。')}</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {tasks.map((task) => {
            const imported = isDiscoveredImported(task, configs)
            return (
              <div key={task.key} className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-qn-hover">
                <div className="pt-0.5">
                  <Checkbox
                    checked={imported || selected.has(task.key)}
                    disabled={imported || disabled}
                    onChange={(on) => toggle(task.key, on)}
                  >
                    <span className="text-ui-sm">{task.name}</span>
                  </Checkbox>
                </div>
                <div className="min-w-0 flex-1 pt-0.5 text-right">
                  <div className="truncate font-mono text-ui-xs text-qn-dim" title={`${task.source}\n${task.detail}`}>
                    {imported ? t('已添加') : task.task.target}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {(result?.warnings.length ?? 0) > 0 && (
        <details className="text-ui-xs text-qn-dim">
          <summary className="cursor-pointer">{t('{count} 条提示', { count: result!.warnings.length })}</summary>
          <ul className="mt-1 list-disc pl-4">
            {result!.warnings.map((warning, index) => (
              <li key={index}>
                {t('{source}：{message}', { source: warning.source, message: translateMessage(warning.message) })}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex items-center gap-2">
        <Checkbox checked={combined} onChange={setCombined} disabled={chosen.length < 2}>
          <span className="text-ui-sm">{t('合并为一个配置')}</span>
        </Checkbox>
        <button
          type="button"
          className="qn-button ml-auto px-2 py-1 text-ui-sm"
          disabled={chosen.length === 0 || saving || disabled}
          onClick={() => void submit()}
        >
          {saving ? t('写入中…') : t('添加选中（{count}）', { count: chosen.length })}
        </button>
      </div>
    </div>
  )
}

function RunOutputArea({
  targetId,
  tabs,
  active,
  stopped,
  onSelect,
  onStop,
}: {
  targetId: string
  tabs: RunInfo[]
  active: RunInfo | null
  stopped: Record<string, true>
  onSelect: (runId: string) => void
  onStop: (runId: string) => void
}) {
  const hide = useRunStore((s) => s.hide)
  const clear = useRunStore((s) => s.clear)
  const output = useRunStore((s) => (active ? s.outputs[active.runId] : undefined))
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (node && autoScroll) node.scrollTop = node.scrollHeight
  }, [output, autoScroll, active?.runId])

  if (tabs.length === 0 || !active) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState>{t('启动配置后，输出会显示在这里。')}</EmptyState>
      </div>
    )
  }

  const running = isRunning(active)
  const copyAll = async (): Promise<void> => {
    if (!output) return
    if (await copyText(outputText(output))) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-target={targetId}>
      <div className="flex shrink-0 items-center gap-1 border-b border-qn-border px-1 py-1">
        <div className="qn-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
          {tabs.map((run) => {
            const selected = run.runId === active.runId
            const live = isRunning(run)
            const failed = !live && run.exitCode !== 0 && !stopped[run.runId]
            return (
              <div
                key={run.runId}
                role="tab"
                aria-selected={selected}
                tabIndex={0}
                className={cn(
                  'flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover',
                  selected ? 'bg-qn-active text-qn-text' : 'text-qn-muted hover:bg-qn-hover',
                )}
                onClick={() => onSelect(run.runId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelect(run.runId)
                }}
              >
                <StatusDot className={live ? 'bg-qn-ok' : failed ? 'bg-qn-danger' : 'bg-qn-dim'} />
                <span className="truncate">{run.label}</span>
                {!live && (
                  <IconButton
                    label={t('关闭输出')}
                    size="sm"
                    tooltip={false}
                    className="size-4 rounded text-qn-dim"
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      hide(run.runId)
                    }}
                  >
                    <X size={12} />
                  </IconButton>
                )}
              </div>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton
            label={autoScroll ? t('自动滚动：开（点击暂停）') : t('自动滚动：已暂停（点击恢复）')}
            size="sm"
            className={autoScroll ? 'text-qn-accent' : ''}
            onClick={() => setAutoScroll((on) => !on)}
          >
            <ArrowDownToLine size={13} />
          </IconButton>
          <IconButton label={t('清空输出')} size="sm" onClick={() => clear(active.runId)}>
            <Eraser size={13} />
          </IconButton>
          <IconButton label={copied ? t('已复制') : t('复制全部输出')} size="sm" onClick={() => void copyAll()}>
            <Copy size={13} />
          </IconButton>
          {running && (
            <IconButton label={t('停止')} size="sm" danger onClick={() => onStop(active.runId)}>
              <Square size={13} />
            </IconButton>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-2 py-1 text-ui-xs text-qn-dim">
        <span className="min-w-0 flex-1 truncate font-mono" title={`${active.workdir}\n${active.command}`}>
          {active.command}
        </span>
        <span className={cn('shrink-0', running ? 'text-qn-ok' : '')}>{runStatusText(active, Boolean(stopped[active.runId]))}</span>
      </div>
      <div
        ref={scrollRef}
        className="qn-scroll min-h-0 flex-1 overflow-auto bg-qn-bg px-2 py-1 font-mono text-ui-sm leading-[18px]"
        onScroll={(event) => {
          const node = event.currentTarget
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          // 向上翻看时自动暂停，回到底部自动恢复。
          if (atBottom !== autoScroll) setAutoScroll(atBottom)
        }}
      >
        {output?.dropped && <div className="text-qn-dim">{t('… 更早的输出已丢弃（最多保留 5000 行）')}</div>}
        <div className="whitespace-pre-wrap break-all text-qn-prose">
          {output?.lines.map((line) => (
            <div key={line.id}>
              <Segments segments={line.segments} />
            </div>
          ))}
          {output && output.current.length > 0 && (
            <div>
              <Segments segments={output.current} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Segments({ segments }: { segments: OutputSegment[] }) {
  if (segments.length === 0) return <>{' '}</>
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          style={styleToCss(segment.style) as CSSProperties}
          className={segment.err && !segment.style.fg ? 'text-qn-danger/90' : undefined}
        >
          {segment.text}
        </span>
      ))}
    </>
  )
}
