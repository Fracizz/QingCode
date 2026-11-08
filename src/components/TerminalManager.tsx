import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  ListTree,
  LoaderCircle,
  MessageCircleMore,
  Monitor,
  Pencil,
  RefreshCw,
  Search,
  Smartphone,
  SquareArrowOutUpRight,
  Undo2,
  X,
  XCircle,
} from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import SegmentedControl from './SegmentedControl'
import { useI18n } from '../lib/i18n'
import { isTauri } from '../lib/tauri'
import { isSshProject, isSshWorkspaceReady } from '../lib/sshWorkspace'
import { killDetachedTerminal } from '../lib/ipc/terminal'
import {
  createCoalescedRunner,
  endMobileSession,
  listenMobileSessionOutput,
  listMobileSessions,
  previewMobileSession,
  renameMobileSession,
  type MobileSessionPreview,
  type MobileSessionSummary,
} from '../lib/ipc/mobileSessions'
import { openMobileSessionTab } from '@/store/terminalStore'
import {
  countTerminalOverview,
  groupTerminalOverview,
  formatCreatedTime,
  idleMinutes,
  isTerminalOverviewEntryExited,
  isTerminalOverviewEntryRunning,
  mobileSessionDisplayName,
  paginateTerminalOverview,
  summarizeTerminalOverviewBatch,
  terminalOverviewEntries,
  type DetachedProjectTerminals,
  type TerminalOverviewEntry,
  type TerminalOverviewFilter,
} from '../lib/terminal/terminalOverview'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import {
  isTerminalProgramBusy,
  subscribeTerminalProgramActivity,
} from '../lib/terminal/terminalProgramActivity'
import { useUIStore } from '../store/uiStore'
import { confirmDialog } from '../store/confirmStore'
import { promptDialog } from '../store/promptStore'
import type { TerminalTab } from '../types'

const MOBILE_REFRESH_MS = 3000
/** 预览由输出事件驱动，这里只是漏掉事件时的兜底。 */
const PREVIEW_FALLBACK_REFRESH_MS = 5000
/** 每页终端条数：终端很多时分页，避免一次渲染过长的列表。 */
const PAGE_SIZE = 30
const BATCH_KEY = 'batch'

const DESKTOP_STATUS: Record<TerminalTab['status'], string> = {
  running: '运行中',
  starting: '启动中',
  reconnecting: '重连中',
  exited: '已退出',
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function validateSessionName(value: string) {
  const name = value.trim()
  if ([...name].length > 80) return '会话名称最多 80 个字符'
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名称不能包含控制字符'
  return null
}

type Translate = ReturnType<typeof useI18n>['t']

/** 行内展示与搜索共用：来源图标、来源标签与状态明细。 */
function describeEntry(entry: TerminalOverviewEntry, now: number, t: Translate) {
  if (entry.source === 'desktop') {
    const created = formatCreatedTime(entry.tab.startedAt, now)
    const status = entry.tab.status === 'running'
      ? isTerminalOverviewEntryRunning(entry, tab => isTerminalProgramBusy(tab.id, now)) ? t('运行中') : t('未结束')
      : t(DESKTOP_STATUS[entry.tab.status])
    return {
      icon: <Monitor size={14} />,
      sourceLabel: t('电脑'),
      details: [status, created ? t('创建于 {time}', { time: created }) : ''].filter(Boolean),
    }
  }
  if (entry.source === 'mobile') {
    const session = entry.session
    const idle = session.exit ? null : idleMinutes(session.lastActiveAt, now)
    const created = formatCreatedTime(session.createdAt, now)
    return {
      icon: <Smartphone size={14} />,
      sourceLabel: t('手机'),
      details: [
        t('终端 {n}', { n: session.number }),
        session.exit ? t('已结束') : session.programBusy ? t('运行中') : t('未结束'),
        session.deviceName ?? t('设备已移除'),
        created ? t('创建于 {time}', { time: created }) : '',
        idle === null ? '' : t('空闲 {n} 分钟', { n: idle }),
        t('仅手机可操作'),
      ].filter(Boolean),
    }
  }
  return { icon: <Cloud size={14} />, sourceLabel: t('远端'), details: [t('未接回 · 仍在远端运行')] }
}

/** 原生复选框，支持半选状态。 */
function Checkbox({
  checked,
  indeterminate = false,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-3.5 w-3.5 flex-shrink-0 cursor-pointer disabled:cursor-default"
    />
  )
}

/**
 * 终端管理：跨项目列出电脑终端、手机终端与 SSH 远端未接回的终端。
 * 手机终端可在这里只读预览、重命名、结束，或打开到电脑标签后接管。
 */
export default function TerminalManager() {
  const { t } = useI18n()
  const close = useUIStore(s => s.closeTerminalManager)
  const projects = useProjectStore(s => s.projects)
  const currentProjectId = useProjectStore(s => s.currentProject?.id ?? null)
  const terminals = useTerminalStore(s => s.terminals)
  const [mobile, setMobile] = useState<MobileSessionSummary[]>([])
  const [mobileError, setMobileError] = useState<string | null>(null)
  const [detached, setDetached] = useState<DetachedProjectTerminals[]>([])
  const [remoteErrors, setRemoteErrors] = useState<string[]>([])
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [filter, setFilter] = useState<TerminalOverviewFilter>('all')
  const [query, setQuery] = useState('')
  // 「运行中优先」是临时排序：点一下把程序正在工作的终端排到组内最前，再点恢复默认顺序；不保存。
  const [runningFirst, setRunningFirst] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // 电脑终端的程序标题开始/停止转圈时刷新，「运行中」与排序及时更新。
  useEffect(() => subscribeTerminalProgramActivity(() => setNow(Date.now())), [])
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const alive = useRef(true)
  const operationBusy = useRef(false)
  const mobileRequest = useRef(0)
  const remoteRequest = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      mobileRequest.current += 1
      remoteRequest.current += 1
    }
  }, [])

  const refreshMobile = useCallback(async () => {
    if (!isTauri()) return
    const request = ++mobileRequest.current
    try {
      const list = await listMobileSessions()
      if (!alive.current || request !== mobileRequest.current) return
      setMobile(list)
      setMobileError(null)
      setNow(Date.now())
    } catch (error) {
      if (alive.current && request === mobileRequest.current) setMobileError(errorText(error))
    }
  }, [])

  const refreshRemote = useCallback(async () => {
    if (!isTauri()) return
    const request = ++remoteRequest.current
    setLoadingRemote(true)
    const sshProjects = useProjectStore.getState().projects.filter(project => !project.ephemeral && isSshProject(project))
    const results = await Promise.all(
      sshProjects.map(async (project): Promise<DetachedProjectTerminals | { error: string } | null> => {
        try {
          // 只查询已就绪的 SSH 项目，不为列表触发连接。
          if (!(await isSshWorkspaceReady(project.path))) return null
          const found = await useTerminalStore.getState().findDetachedTerminals(project.id)
          return found && found.terminals.length > 0 ? { projectId: project.id, ...found } : null
        } catch (error) {
          return { error: `${project.name}: ${errorText(error)}` }
        }
      }),
    )
    if (!alive.current || request !== remoteRequest.current) return
    const found: DetachedProjectTerminals[] = []
    const errors: string[] = []
    for (const item of results) {
      if (!item) continue
      if ('error' in item) errors.push(item.error)
      else found.push(item)
    }
    setDetached(found)
    setRemoteErrors(errors)
    setLoadingRemote(false)
  }, [])

  const refreshAll = useCallback(() => {
    if (operationBusy.current) return
    void refreshMobile()
    void refreshRemote()
  }, [refreshMobile, refreshRemote])

  useEffect(() => {
    const initial = window.setTimeout(refreshAll, 0)
    const timer = window.setInterval(() => {
      if (!document.hidden && !operationBusy.current) void refreshMobile()
    }, MOBILE_REFRESH_MS)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refreshAll, refreshMobile])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f'
        && event.target instanceof Node && listRef.current?.closest('[role="dialog"]')?.contains(event.target)) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const entries = useMemo(
    () => terminalOverviewEntries({
      projects,
      // 打开到电脑标签的手机终端仍按手机会话列出，不重复显示。
      terminals: terminals.filter(tab => !tab.id.startsWith('mobile-')),
      mobile,
      detached,
    }),
    [projects, terminals, mobile, detached],
  )
  const counts = useMemo(() => countTerminalOverview(entries), [entries])
  const groups = useMemo(
    () =>
      groupTerminalOverview(
        entries,
        projects,
        filter,
        query,
        entry => {
          const { sourceLabel, details } = describeEntry(entry, now, t)
          return [sourceLabel, ...details]
        },
        runningFirst ? entry => isTerminalOverviewEntryRunning(entry, tab => isTerminalProgramBusy(tab.id, now)) : undefined,
      ),
    [entries, projects, filter, query, now, t, runningFirst],
  )
  const paged = useMemo(() => paginateTerminalOverview(groups, page, PAGE_SIZE), [groups, page])
  /** 当前筛选/搜索结果中的全部终端（跨页），批量操作都以此为范围。 */
  const visibleEntries = useMemo(() => groups.flatMap(group => group.entries), [groups])
  const selectedEntries = useMemo(
    () => visibleEntries.filter(entry => selected.has(entry.key)),
    [visibleEntries, selected],
  )
  const exitedVisible = useMemo(() => visibleEntries.filter(isTerminalOverviewEntryExited), [visibleEntries])
  const allSelected = visibleEntries.length > 0 && selectedEntries.length === visibleEntries.length
  const operationPending = busyKey !== null
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [paged.page, query, filter, runningFirst])
  if (page !== paged.page) setPage(paged.page)

  const changeFilter = (next: TerminalOverviewFilter) => {
    if (operationBusy.current) return
    setFilter(next)
    setPage(0)
    setSelected(new Set())
  }
  const changeQuery = (next: string) => {
    if (operationBusy.current) return
    setQuery(next)
    setPage(0)
    setSelected(new Set())
  }
  const toggleSelected = (keys: readonly string[], on: boolean) =>
    setSelected(previous => {
      const next = new Set(previous)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })

  const run = async (key: string, action: () => Promise<void>) => {
    if (operationBusy.current) return
    operationBusy.current = true
    mobileRequest.current += 1
    remoteRequest.current += 1
    setLoadingRemote(false)
    setBusyKey(key)
    try {
      await action()
    } catch (error) {
      useProjectStore.getState().pushToast('error', errorText(error))
    } finally {
      operationBusy.current = false
      if (alive.current) setBusyKey(null)
    }
  }

  const jumpToDesktop = (tab: TerminalTab) =>
    run(`desktop:${tab.id}`, async () => {
      const projectState = useProjectStore.getState()
      if (projectState.currentProject?.id !== tab.projectId) {
        const project = projectState.projects.find(candidate => candidate.id === tab.projectId)
        if (!project) throw new Error(t('终端所属项目已不在项目列表中'))
        if (!(await projectState.switchProject(project))) return
      }
      useTerminalStore.getState().setActiveTerminal(tab.id)
      useUIStore.getState().openTerminalPanel()
      close()
    })

  const renameDesktop = (tab: TerminalTab) => run(`desktop:${tab.id}`, async () => {
    const name = await promptDialog({
      title: t('重命名终端'),
      defaultValue: tab.name,
      validate: value => (value.trim() ? null : t('名称不能为空')),
    })
    if (name?.trim()) useTerminalStore.getState().renameTerminal(tab.id, name.trim())
  })

  const endDesktop = (tab: TerminalTab) =>
    run(`desktop:${tab.id}`, async () => {
      if (tab.status !== 'exited') {
        const ok = await confirmDialog({
          title: t('结束终端'),
          message: t('结束「{name}」并关闭其中正在运行的程序？', { name: tab.name }),
          kind: 'danger',
          confirmLabel: t('结束'),
        })
        if (!ok) return
      }
      await useTerminalStore.getState().closeTerminal(tab.id)
    })

  const openMobile = async (session: MobileSessionSummary) => {
    const opened: { tab?: TerminalTab } = {}
    await run(`mobile:${session.id}`, async () => {
      opened.tab = await openMobileSessionTab(session)
    })
    if (opened.tab) await jumpToDesktop(opened.tab)
  }

  const renameMobile = (session: MobileSessionSummary) => run(`mobile:${session.id}`, async () => {
    const name = await promptDialog({
      title: t('重命名手机终端'),
      message: t('名称会同步到手机；留空则恢复默认名称。'),
      defaultValue: mobileSessionDisplayName(session),
      validate: value => {
        const message = validateSessionName(value)
        return message ? t(message) : null
      },
    })
    if (name === null || name === undefined) return
    await renameMobileSession(session.id, name.trim())
    await refreshMobile()
  })

  const endMobile = (session: MobileSessionSummary) =>
    run(`mobile:${session.id}`, async () => {
      if (!session.exit) {
        const ok = await confirmDialog({
          title: t('结束手机终端'),
          message: t('结束手机上的「{name}」并关闭其中正在运行的程序？', { name: session.name }),
          detail: t('手机端会显示该会话已结束。'),
          kind: 'danger',
          confirmLabel: t('结束'),
        })
        if (!ok) return
      }
      await endMobileSession(session.id)
      if (alive.current) setMobile(previous => previous.filter(item => item.id !== session.id))
      if (previewId === session.id) setPreviewId(null)
      await refreshMobile()
    })

  const attachRemote = (entry: Extract<TerminalOverviewEntry, { source: 'remote' }>) =>
    run(entry.key, async () => {
      await useTerminalStore
        .getState()
        .attachDetachedTerminals(entry.projectId, entry.connectionId, [entry.terminal])
      await refreshRemote()
    })

  const endRemote = (entry: Extract<TerminalOverviewEntry, { source: 'remote' }>) =>
    run(entry.key, async () => {
      const ok = await confirmDialog({
        title: t('结束远端终端'),
        message: t('结束远端的「{name}」并关闭其中正在运行的程序？', { name: entry.name }),
        kind: 'danger',
        confirmLabel: t('结束'),
      })
      if (!ok) return
      if (useTerminalStore.getState().terminals.some(tab => tab.ptyId === entry.terminal.ptyId
        && (!tab.connectionId || tab.connectionId === entry.connectionId))) {
        throw new Error(t('远端终端已接回，请刷新列表后重试。'))
      }
      await killDetachedTerminal({ ptyId: entry.terminal.ptyId, cwd: entry.terminal.cwd })
      if (alive.current) setDetached(previous => previous.map(group => group.connectionId !== entry.connectionId ? group : {
        ...group, terminals: group.terminals.filter(terminal => terminal.ptyId !== entry.terminal.ptyId),
      }))
      await refreshRemote()
    })

  /** 批量关闭：电脑标签关闭、手机会话结束/移除、远端终端结束；一次确认。 */
  const endEntries = (targets: readonly TerminalOverviewEntry[], title: string) =>
    run(BATCH_KEY, async () => {
      if (targets.length === 0) return
      const summary = summarizeTerminalOverviewBatch(targets)
      const ok = await confirmDialog({
        title,
        message: t('关闭 {n} 个终端？', { n: summary.total }),
        detail: [
          summary.running > 0
            ? t('其中 {n} 个仍在运行，其中的程序会被结束；手机终端会在手机上显示已结束。', { n: summary.running })
            : t('它们都已退出，关闭后会从列表中移除。'),
          t('仅操作当前筛选/搜索结果（含其他页），不会关闭隐藏的终端。'),
        ].join('\n'),
        kind: summary.running > 0 ? 'danger' : 'warning',
        confirmLabel: t('关闭'),
      })
      if (!ok) return
      const results = await Promise.allSettled(
        targets.map(async entry => {
          if (entry.source === 'desktop') {
            await useTerminalStore.getState().closeTerminal(entry.tab.id)
            // closeTerminal 失败时会自行提示并保留标签，这里据此判定失败。
            if (useTerminalStore.getState().terminals.some(tab => tab.id === entry.tab.id)) {
              throw new Error(t('关闭终端失败'))
            }
          } else if (entry.source === 'mobile') {
            await endMobileSession(entry.session.id)
          } else {
            if (useTerminalStore.getState().terminals.some(tab => tab.ptyId === entry.terminal.ptyId
              && (!tab.connectionId || tab.connectionId === entry.connectionId))) {
              throw new Error(t('远端终端已接回，请刷新列表后重试。'))
            }
            await killDetachedTerminal({ ptyId: entry.terminal.ptyId, cwd: entry.terminal.cwd })
          }
        }),
      )
      const closedKeys = targets.filter((_, index) => results[index].status === 'fulfilled').map(entry => entry.key)
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (alive.current) {
        toggleSelected(closedKeys, false)
        const closed = new Set(closedKeys)
        setMobile(previous => previous.filter(session => !closed.has(`mobile:${session.id}`)))
        setDetached(previous => previous.map(group => ({ ...group,
          terminals: group.terminals.filter(terminal => !closed.has(`remote:${group.connectionId}:${terminal.ptyId}`)),
        })))
        if (closed.has(`mobile:${previewId}`)) setPreviewId(null)
      }
      const toast = useProjectStore.getState().pushToast
      if (failures.length > 0) {
        toast(
          'warn',
          t('已关闭 {ok} 个终端，{n} 个失败', { ok: closedKeys.length, n: failures.length }),
          errorText(failures[0].reason),
        )
      } else {
        toast('success', t('已关闭 {n} 个终端', { n: closedKeys.length }))
      }
      const tasks: Promise<void>[] = []
      if (targets.some(entry => entry.source === 'mobile')) tasks.push(refreshMobile())
      if (targets.some(entry => entry.source === 'remote')) tasks.push(refreshRemote())
      await Promise.all(tasks)
    })

  const filterOptions: { value: TerminalOverviewFilter; label: string }[] = [
    { value: 'all', label: t('全部 {n}', { n: counts.all }) },
    { value: 'desktop', label: t('电脑 {n}', { n: counts.desktop }) },
    { value: 'mobile', label: t('手机 {n}', { n: counts.mobile }) },
    { value: 'remote', label: t('远端未接回 {n}', { n: counts.remote }) },
  ]

  return (
    <ModalOverlay onDismiss={close} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-busy={operationPending}
        aria-labelledby="terminal-manager-title"
        className="ui-font-scaled modal-content-enter relative flex h-[min(66vh,680px)] min-h-[min(320px,calc(100dvh-2rem))] w-[94vw] max-w-[860px] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-fg shadow-elevation-3"
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex min-h-12 flex-shrink-0 items-center justify-between gap-3 border-b border-dialog-separator bg-dialog-chrome px-4 py-2">
          <div className="flex min-w-0 items-center gap-2 text-ui-lg font-semibold text-fg">
            <ListTree size={16} className="text-fg-muted" />
            <h2 id="terminal-manager-title">{t('终端管理')}</h2>
            <span className="hidden truncate text-ui-sm font-normal text-fg-muted sm:inline">
              {t('全部项目 · 电脑 · 手机 · 远端')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip label={t('刷新')} side="bottom">
              <button
                type="button"
                aria-label={t('刷新')}
                disabled={operationPending}
                onClick={refreshAll}
                className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
              >
                <RefreshCw size={16} className={loadingRemote ? 'motion-safe:animate-spin' : ''} />
              </button>
            </Tooltip>
            <Tooltip label={t('关闭')} side="left">
              <button
                type="button"
                aria-label={t('关闭')}
                onClick={close}
                className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
              >
                <X size={18} />
              </button>
            </Tooltip>
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-dialog-separator px-4 py-2">
          <SegmentedControl
            options={filterOptions.map(option => ({ ...option, disabled: operationPending }))}
            value={filter}
            onChange={changeFilter}
            ariaLabel={t('按来源筛选')}
          />
          <label className="flex min-w-[180px] flex-1 items-center gap-1 rounded border border-border-strong bg-dialog-input px-2">
            <Search size={13} className="text-fg-dim" />
            <input
              ref={searchRef}
              data-modal-autofocus
              disabled={operationPending}
              value={query}
              onChange={event => changeQuery(event.target.value)}
              placeholder={t('搜索名称、项目、设备或状态')}
              aria-label={t('搜索名称、项目、设备或状态')}
              className="h-7 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-fg-dim"
            />
            {query && (
              <Tooltip label={t('清除搜索')} side="bottom">
                <button
                  type="button"
                  aria-label={t('清除搜索')}
                  onClick={() => {
                    changeQuery('')
                    searchRef.current?.focus()
                  }}
                  className="rounded p-0.5 text-fg-dim hover:bg-bg-hover hover:text-fg"
                >
                  <X size={13} />
                </button>
              </Tooltip>
            )}
          </label>
          <Tooltip label={runningFirst ? t('运行中优先 · 再点恢复默认顺序') : t('运行中优先')} side="bottom">
            <button
              type="button"
              aria-label={runningFirst ? t('运行中优先 · 再点恢复默认顺序') : t('运行中优先')}
              aria-pressed={runningFirst}
              onClick={() => setRunningFirst(value => !value)}
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border ${
                runningFirst
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-transparent text-fg-dim hover:bg-bg-hover hover:text-fg'
              }`}
            >
              <MessageCircleMore size={15} />
            </button>
          </Tooltip>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {(mobileError || remoteErrors.length > 0) && (
            <div className="mb-3 space-y-1 rounded border border-border px-3 py-2 text-ui-sm text-fg-muted">
              {mobileError && <p>{t('读取手机终端失败：{error}', { error: mobileError })}</p>}
              {remoteErrors.map(error => (
                <p key={error}>{t('查询远端终端失败：{error}', { error })}</p>
              ))}
            </div>
          )}
          {paged.groups.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-ui-sm text-fg-muted">
              <p className="text-ui text-fg">{query || filter !== 'all' ? t('没有匹配的终端') : t('还没有终端')}</p>
              <p>{t('电脑终端、手机终端和远端未接回的终端都会列在这里。')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {paged.groups.map(group => {
                const groupKeys = group.entries.map(entry => entry.key)
                const groupSelected = groupKeys.filter(key => selected.has(key)).length
                return (
                <section key={group.projectId} aria-label={group.projectName}>
                  <h3 className="mb-1 flex items-center gap-2 px-3 text-ui-sm font-semibold text-fg-muted">
                    <Checkbox
                      label={t('选择项目「{name}」本页的终端', { name: group.projectName })}
                      checked={groupSelected > 0 && groupSelected === groupKeys.length}
                      indeterminate={groupSelected > 0}
                      disabled={operationPending}
                      onChange={() => toggleSelected(groupKeys, groupSelected !== groupKeys.length)}
                    />
                    <span className="truncate">{group.projectName}</span>
                    {group.projectId === currentProjectId && (
                      <span className="rounded bg-bg-active px-1 text-[11px] font-normal text-brand">{t('当前项目')}</span>
                    )}
                    {group.missing && (
                      <span className="rounded bg-bg-active px-1 text-[11px] font-normal">{t('不在项目列表中')}</span>
                    )}
                    <span className="font-normal">
                      {group.entries.length === group.total ? group.total : `${group.entries.length}/${group.total}`}
                    </span>
                  </h3>
                  <ul className="divide-y divide-border overflow-hidden rounded border border-border">
                    {group.entries.map(entry => (
                      <li key={entry.key}>
                        <Row
                          entry={entry}
                          now={now}
                          selected={selected.has(entry.key)}
                          onToggleSelect={() => toggleSelected([entry.key], !selected.has(entry.key))}
                          busy={busyKey === entry.key}
                          disabled={busyKey !== null}
                          previewOpen={entry.source === 'mobile' && previewId === entry.session.id}
                          onJump={jumpToDesktop}
                          onRenameDesktop={tab => void renameDesktop(tab)}
                          onEndDesktop={endDesktop}
                          onTogglePreview={id => setPreviewId(current => (current === id ? null : id))}
                          onOpenMobile={session => void openMobile(session)}
                          onRenameMobile={session => void renameMobile(session)}
                          onEndMobile={endMobile}
                          onAttachRemote={attachRemote}
                          onEndRemote={endRemote}
                        />
                        {entry.source === 'mobile' && previewId === entry.session.id && (
                          <MobilePreview id={entry.session.id} />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-dialog-separator bg-dialog-chrome px-4 py-1.5 text-ui-sm">
          <label className="inline-flex items-center gap-2 px-3 text-fg-muted">
            <Checkbox
              label={t('全选当前结果')}
              checked={allSelected}
              indeterminate={selectedEntries.length > 0}
              disabled={operationPending || visibleEntries.length === 0}
              onChange={() => toggleSelected(visibleEntries.map(entry => entry.key), !allSelected)}
            />
            <span>
              {selectedEntries.length > 0
                ? t('已选 {n} / {total}', { n: selectedEntries.length, total: visibleEntries.length })
                : t('全选结果（跨页）')}
            </span>
          </label>
          <button
            type="button"
            disabled={operationPending || exitedVisible.length === 0}
            onClick={() => toggleSelected(exitedVisible.map(entry => entry.key), true)}
            className="rounded px-2 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {t('选中已退出 {n}', { n: exitedVisible.length })}
          </button>
          {selectedEntries.length > 0 && (
            <>
              <button
                type="button"
                disabled={busyKey !== null}
                onClick={() => void endEntries(selectedEntries, t('关闭所选终端'))}
                className="rounded px-2 py-0.5 text-danger hover:bg-bg-hover disabled:opacity-40"
              >
                {t('关闭所选 {n}', { n: selectedEntries.length })}
              </button>
              <button
                type="button"
                disabled={operationPending}
                onClick={() => setSelected(new Set())}
                className="rounded px-2 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
              >
                {t('取消选择')}
              </button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {paged.pageCount > 1 && (
              <nav className="flex items-center gap-0.5 text-fg-muted" aria-label={t('分页')}>
                <Tooltip label={t('上一页')} side="top">
                  <button
                    type="button"
                    aria-label={t('上一页')}
                    disabled={operationPending || paged.page === 0}
                    onClick={() => setPage(paged.page - 1)}
                    className="rounded p-0.5 hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <ChevronLeft size={15} />
                  </button>
                </Tooltip>
                <span className="min-w-[4.5em] text-center tabular-nums">
                  {t('{page} / {count} 页', { page: paged.page + 1, count: paged.pageCount })}
                </span>
                <Tooltip label={t('下一页')} side="top">
                  <button
                    type="button"
                    aria-label={t('下一页')}
                    disabled={operationPending || paged.page >= paged.pageCount - 1}
                    onClick={() => setPage(paged.page + 1)}
                    className="rounded p-0.5 hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <ChevronRight size={15} />
                  </button>
                </Tooltip>
              </nav>
            )}
            <Tooltip
              label={
                query || filter !== 'all'
                  ? t('关闭当前筛选/搜索结果中的全部 {n} 个终端', { n: visibleEntries.length })
                  : t('关闭全部 {n} 个终端', { n: visibleEntries.length })
              }
              side="top"
            >
              <button
                type="button"
                disabled={busyKey !== null || visibleEntries.length === 0}
                onClick={() => void endEntries(visibleEntries, query.trim() || filter !== 'all' ? t('关闭筛选结果') : t('全部关闭'))}
                className="rounded border border-border px-2 py-0.5 text-danger hover:bg-bg-hover disabled:opacity-40"
              >
                {query.trim() || filter !== 'all' ? t('关闭筛选结果') : t('全部关闭')}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}

interface RowProps {
  entry: TerminalOverviewEntry
  now: number
  selected: boolean
  onToggleSelect: () => void
  busy: boolean
  disabled: boolean
  previewOpen: boolean
  onJump: (tab: TerminalTab) => void
  onRenameDesktop: (tab: TerminalTab) => void
  onEndDesktop: (tab: TerminalTab) => void
  onTogglePreview: (id: string) => void
  onOpenMobile: (session: MobileSessionSummary) => void
  onRenameMobile: (session: MobileSessionSummary) => void
  onEndMobile: (session: MobileSessionSummary) => void
  onAttachRemote: (entry: Extract<TerminalOverviewEntry, { source: 'remote' }>) => void
  onEndRemote: (entry: Extract<TerminalOverviewEntry, { source: 'remote' }>) => void
}

function Row(props: RowProps) {
  const { t } = useI18n()
  const { entry, now, disabled } = props
  const { icon, sourceLabel, details } = describeEntry(entry, now, t)
  const originalName = entry.source === 'mobile' ? [entry.session.name, entry.session.programTitle]
    .filter((value, index, values) => value && values.indexOf(value) === index).join('\n') : entry.name
  let actions: { label: string; icon: ReactNode; danger?: boolean; onClick: () => void }[]

  if (entry.source === 'desktop') {
    const tab = entry.tab
    actions = [
      { label: t('跳转到终端'), icon: <SquareArrowOutUpRight size={14} />, onClick: () => props.onJump(tab) },
      { label: t('重命名'), icon: <Pencil size={14} />, onClick: () => props.onRenameDesktop(tab) },
      { label: t('结束'), icon: <XCircle size={14} />, danger: true, onClick: () => props.onEndDesktop(tab) },
    ]
  } else if (entry.source === 'mobile') {
    const session = entry.session
    actions = [
      ...(session.exit
        ? []
        : [{
            label: t('在电脑上打开'),
            icon: <SquareArrowOutUpRight size={14} />,
            onClick: () => props.onOpenMobile(session),
          }]),
      {
        label: props.previewOpen ? t('收起预览') : t('只读预览'),
        icon: props.previewOpen ? <EyeOff size={14} /> : <Eye size={14} />,
        onClick: () => props.onTogglePreview(session.id),
      },
      { label: t('重命名'), icon: <Pencil size={14} />, onClick: () => props.onRenameMobile(session) },
      {
        label: session.exit ? t('移除') : t('结束'),
        icon: <XCircle size={14} />,
        danger: true,
        onClick: () => props.onEndMobile(session),
      },
    ]
  } else {
    actions = [
      { label: t('接回为终端标签'), icon: <Undo2 size={14} />, onClick: () => props.onAttachRemote(entry) },
      { label: t('结束'), icon: <XCircle size={14} />, danger: true, onClick: () => props.onEndRemote(entry) },
    ]
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 hover:bg-bg-hover ${props.selected ? 'bg-bg-active/60' : ''}`}
      aria-busy={props.busy}
    >
      <Checkbox
        label={t('选择终端「{name}」', { name: entry.name })}
        checked={props.selected}
        disabled={disabled}
        onChange={props.onToggleSelect}
      />
      <Tooltip label={sourceLabel} side="top" wrapperClassName="inline-flex">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-muted" aria-label={sourceLabel}>
          {icon}
        </span>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          {isTerminalOverviewEntryRunning(entry, tab => isTerminalProgramBusy(tab.id, now)) && (
            // 程序标题在转圈：用持续转动的图标代替标题里随轮询跳动的转圈帧字符。
            <Tooltip label={t('程序正在工作')} side="top" wrapperClassName="inline-flex flex-shrink-0">
              <LoaderCircle
                size={13}
                role="img"
                aria-label={t('程序正在工作')}
                className="text-brand motion-safe:animate-spin"
              />
            </Tooltip>
          )}
          <Tooltip label={originalName} onlyWhenOverflow={originalName === entry.name} side="top" wrapperClassName="block min-w-0 flex-1">
            <div className="truncate text-ui text-fg">{entry.name}</div>
          </Tooltip>
        </div>
        <div className="truncate text-ui-sm text-fg-muted">{details.join(' · ')}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5">
        {actions.map(action => (
          <Tooltip key={action.label} label={action.label} side="top">
            <button
              type="button"
              aria-label={`${action.label}：${entry.name}`}
              disabled={disabled}
              onClick={action.onClick}
              className={`rounded p-1 text-fg-dim transition-colors hover:bg-bg-active disabled:opacity-40 ${
                action.danger ? 'hover:text-danger' : 'hover:text-fg'
              }`}
            >
              {action.icon}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/** 手机终端只读预览：纯文本，随终端输出实时刷新；不向终端发送任何输入或尺寸。 */
function MobilePreview({ id }: { id: string }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<MobileSessionPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLPreElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    let cancelled = false
    let stopListening: (() => void) | null = null
    const load = async () => {
      try {
        const next = await previewMobileSession(id)
        if (cancelled) return
        // 更新文本会清掉选区：用户正在预览里选字时先不刷新，取消选择后的下一次刷新再补上。
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && scroller.current?.contains(selection.anchorNode)) return
        setPreview(next)
        setError(null)
      } catch (loadError) {
        if (!cancelled) setError(errorText(loadError))
      }
    }
    const refresh = createCoalescedRunner(load)
    const refreshIfVisible = () => {
      if (!document.hidden) refresh()
    }
    refresh()
    const timer = window.setInterval(refreshIfVisible, PREVIEW_FALLBACK_REFRESH_MS)
    document.addEventListener('visibilitychange', refreshIfVisible)
    listenMobileSessionOutput(id, refreshIfVisible)
      .then(stop => {
        if (cancelled) {
          stop()
          return
        }
        stopListening = stop
        // 补上首次读取与监听生效之间的输出。
        refreshIfVisible()
      })
      .catch(() => {
        // 监听失败时仍有定时刷新兜底。
      })
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      stopListening?.()
    }
  }, [id])

  useEffect(() => {
    const element = scroller.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [preview])

  const text = preview
    ? [...preview.history, ...(preview.history.length ? [''] : []), preview.screen.replace(/\s+$/, '')].join('\n')
    : ''

  return (
    <div className="border-t border-border bg-bg-deep px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-ui-sm text-fg-muted">
        <span>
          {t('只读预览，不会向手机终端发送输入')}
          {preview?.alternate ? ` · ${t('全屏程序只显示当前画面')}` : ''}
          {preview?.truncated ? ` · ${t('仅显示最近 200 行历史')}` : ''}
        </span>
        {preview && <span className="font-mono">{preview.cols}×{preview.rows}</span>}
      </div>
      {error ? (
        <p className="text-ui-sm text-danger">{t('预览失败：{error}', { error })}</p>
      ) : (
        <pre
          ref={scroller}
          onScroll={event => {
            const element = event.currentTarget
            stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
          }}
          className="max-h-72 overflow-auto whitespace-pre font-mono text-[12px] leading-[1.35] text-fg"
        >
          {preview ? text || t('（暂无输出）') : t('正在读取…')}
        </pre>
      )}
    </div>
  )
}
