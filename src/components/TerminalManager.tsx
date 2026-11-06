import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Cloud,
  Eye,
  EyeOff,
  ListTree,
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
  endMobileSession,
  listMobileSessions,
  previewMobileSession,
  renameMobileSession,
  type MobileSessionPreview,
  type MobileSessionSummary,
} from '../lib/ipc/mobileSessions'
import {
  countTerminalOverview,
  groupTerminalOverview,
  idleMinutes,
  terminalOverviewEntries,
  type DetachedProjectTerminals,
  type TerminalOverviewEntry,
  type TerminalOverviewFilter,
} from '../lib/terminal/terminalOverview'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { confirmDialog } from '../store/confirmStore'
import { promptDialog } from '../store/promptStore'
import type { TerminalTab } from '../types'

const MOBILE_REFRESH_MS = 3000
const PREVIEW_REFRESH_MS = 2000

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

/**
 * 终端管理：跨项目列出电脑终端、手机终端与 SSH 远端未接回的终端。
 * 手机终端只归手机使用——这里只能只读预览、重命名和结束，不能输入或接管。
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
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refreshMobile = useCallback(async () => {
    if (!isTauri()) return
    try {
      const list = await listMobileSessions()
      if (!alive.current) return
      setMobile(list)
      setMobileError(null)
      setNow(Date.now())
    } catch (error) {
      if (alive.current) setMobileError(errorText(error))
    }
  }, [])

  const refreshRemote = useCallback(async () => {
    if (!isTauri()) return
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
    if (!alive.current) return
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
    void refreshMobile()
    void refreshRemote()
  }, [refreshMobile, refreshRemote])

  useEffect(() => {
    const initial = window.setTimeout(refreshAll, 0)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshMobile()
    }, MOBILE_REFRESH_MS)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refreshAll, refreshMobile])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const entries = useMemo(
    () => terminalOverviewEntries({ projects, terminals, mobile, detached }),
    [projects, terminals, mobile, detached],
  )
  const counts = useMemo(() => countTerminalOverview(entries), [entries])
  const groups = useMemo(
    () => groupTerminalOverview(entries, projects, filter, query),
    [entries, projects, filter, query],
  )

  const run = async (key: string, action: () => Promise<void>) => {
    if (busyKey) return
    setBusyKey(key)
    try {
      await action()
    } catch (error) {
      useProjectStore.getState().pushToast('error', errorText(error))
    } finally {
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

  const renameDesktop = async (tab: TerminalTab) => {
    const name = await promptDialog({
      title: t('重命名终端'),
      defaultValue: tab.name,
      validate: value => (value.trim() ? null : t('名称不能为空')),
    })
    if (name?.trim()) useTerminalStore.getState().renameTerminal(tab.id, name.trim())
  }

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

  const renameMobile = async (session: MobileSessionSummary) => {
    const name = await promptDialog({
      title: t('重命名手机终端'),
      message: t('名称会同步到手机；留空则恢复默认名称。'),
      defaultValue: session.name,
      validate: value => {
        const message = validateSessionName(value)
        return message ? t(message) : null
      },
    })
    if (name === null || name === undefined) return
    await run(`mobile:${session.id}`, async () => {
      await renameMobileSession(session.id, name.trim())
      await refreshMobile()
    })
  }

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
      await killDetachedTerminal({ ptyId: entry.terminal.ptyId, cwd: entry.terminal.cwd })
      await refreshRemote()
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
        aria-labelledby="terminal-manager-title"
        className="ui-font-scaled modal-content-enter relative flex h-[80vh] w-[94vw] max-w-[860px] max-h-[85vh] flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-fg shadow-elevation-3"
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
                onClick={refreshAll}
                className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
              >
                <RefreshCw size={16} className={loadingRemote ? 'animate-spin' : ''} />
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
            options={filterOptions}
            value={filter}
            onChange={setFilter}
            ariaLabel={t('按来源筛选')}
          />
          <label className="flex min-w-[180px] flex-1 items-center gap-1 rounded border border-border-strong bg-dialog-input px-2">
            <Search size={13} className="text-fg-dim" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('搜索终端、项目或设备')}
              aria-label={t('搜索终端、项目或设备')}
              className="h-7 min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-fg-dim"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {(mobileError || remoteErrors.length > 0) && (
            <div className="mb-3 space-y-1 rounded border border-border px-3 py-2 text-ui-sm text-fg-muted">
              {mobileError && <p>{t('读取手机终端失败：{error}', { error: mobileError })}</p>}
              {remoteErrors.map(error => (
                <p key={error}>{t('查询远端终端失败：{error}', { error })}</p>
              ))}
            </div>
          )}
          {groups.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-ui-sm text-fg-muted">
              <p className="text-ui text-fg">{query || filter !== 'all' ? t('没有匹配的终端') : t('还没有终端')}</p>
              <p>{t('电脑终端、手机终端和远端未接回的终端都会列在这里。')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map(group => (
                <section key={group.projectId} aria-label={group.projectName}>
                  <h3 className="mb-1 flex items-center gap-2 text-ui-sm font-semibold text-fg-muted">
                    <span className="truncate">{group.projectName}</span>
                    {group.projectId === currentProjectId && (
                      <span className="rounded bg-bg-active px-1 text-[11px] font-normal text-brand">{t('当前项目')}</span>
                    )}
                    {group.missing && (
                      <span className="rounded bg-bg-active px-1 text-[11px] font-normal">{t('不在项目列表中')}</span>
                    )}
                    <span className="font-normal">{group.entries.length}</span>
                  </h3>
                  <ul className="divide-y divide-border overflow-hidden rounded border border-border">
                    {group.entries.map(entry => (
                      <li key={entry.key}>
                        <Row
                          entry={entry}
                          now={now}
                          busy={busyKey === entry.key}
                          disabled={busyKey !== null}
                          previewOpen={entry.source === 'mobile' && previewId === entry.session.id}
                          onJump={jumpToDesktop}
                          onRenameDesktop={tab => void renameDesktop(tab)}
                          onEndDesktop={endDesktop}
                          onTogglePreview={id => setPreviewId(current => (current === id ? null : id))}
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
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

interface RowProps {
  entry: TerminalOverviewEntry
  now: number
  busy: boolean
  disabled: boolean
  previewOpen: boolean
  onJump: (tab: TerminalTab) => void
  onRenameDesktop: (tab: TerminalTab) => void
  onEndDesktop: (tab: TerminalTab) => void
  onTogglePreview: (id: string) => void
  onRenameMobile: (session: MobileSessionSummary) => void
  onEndMobile: (session: MobileSessionSummary) => void
  onAttachRemote: (entry: Extract<TerminalOverviewEntry, { source: 'remote' }>) => void
  onEndRemote: (entry: Extract<TerminalOverviewEntry, { source: 'remote' }>) => void
}

function Row(props: RowProps) {
  const { t } = useI18n()
  const { entry, now, disabled } = props
  let icon: ReactNode
  let sourceLabel: string
  let details: string[]
  let actions: { label: string; icon: ReactNode; danger?: boolean; onClick: () => void }[]

  if (entry.source === 'desktop') {
    icon = <Monitor size={14} />
    sourceLabel = t('电脑')
    const tab = entry.tab
    details = [t(DESKTOP_STATUS[tab.status])]
    actions = [
      { label: t('跳转到终端'), icon: <SquareArrowOutUpRight size={14} />, onClick: () => props.onJump(tab) },
      { label: t('重命名'), icon: <Pencil size={14} />, onClick: () => props.onRenameDesktop(tab) },
      { label: t('结束'), icon: <XCircle size={14} />, danger: true, onClick: () => props.onEndDesktop(tab) },
    ]
  } else if (entry.source === 'mobile') {
    const session = entry.session
    icon = <Smartphone size={14} />
    sourceLabel = t('手机')
    const idle = session.exit ? null : idleMinutes(session.lastActiveAt, now)
    details = [
      t('终端 {n}', { n: session.number }),
      session.exit ? t('已结束') : t('运行中'),
      session.deviceName ?? t('设备已移除'),
      idle === null ? '' : t('空闲 {n} 分钟', { n: idle }),
      t('仅手机可操作'),
    ].filter(Boolean)
    actions = [
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
    icon = <Cloud size={14} />
    sourceLabel = t('远端')
    details = [t('未接回 · 仍在远端运行')]
    actions = [
      { label: t('接回为终端标签'), icon: <Undo2 size={14} />, onClick: () => props.onAttachRemote(entry) },
      { label: t('结束'), icon: <XCircle size={14} />, danger: true, onClick: () => props.onEndRemote(entry) },
    ]
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover" aria-busy={props.busy}>
      <Tooltip label={sourceLabel} side="top" wrapperClassName="inline-flex">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-muted" aria-label={sourceLabel}>
          {icon}
        </span>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <Tooltip label={entry.name} onlyWhenOverflow side="top" wrapperClassName="block min-w-0">
          <div className="truncate text-ui text-fg">{entry.name}</div>
        </Tooltip>
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

/** 手机终端只读预览：纯文本，定时刷新；不向终端发送任何输入或尺寸。 */
function MobilePreview({ id }: { id: string }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<MobileSessionPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLPreElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await previewMobileSession(id)
        if (cancelled) return
        setPreview(next)
        setError(null)
      } catch (loadError) {
        if (!cancelled) setError(errorText(loadError))
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, PREVIEW_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
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
