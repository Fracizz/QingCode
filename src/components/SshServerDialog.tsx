import { useId, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  Server,
  Settings2,
  X,
} from 'lucide-react'
import { useI18n } from '../lib/i18n'
import {
  parseSshServerTimings,
  type SshServerState,
  type SshServerTimingStage,
} from '../lib/sshServerStatus'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'

type View = 'details' | 'logs'

interface Props {
  state: SshServerState
  connectionLabel: string
  projectPath: string
  view: View
  busy: boolean
  blocker: string | null
  logs: string
  logsLoading: boolean
  logsError: string | null
  onViewChange: (view: View) => void
  onRefreshLogs: () => void
  onRestart: () => void
  onEnableServer: () => void
  onSettings: () => void
  onClose: () => void
}

export default function SshServerDialog({
  state,
  connectionLabel,
  projectPath,
  view,
  busy,
  blocker,
  logs,
  logsLoading,
  logsError,
  onViewChange,
  onRefreshLogs,
  onRestart,
  onEnableServer,
  onSettings,
  onClose,
}: Props) {
  const { t } = useI18n()
  const id = useId()
  const agent = state.transport === 'agent'
  const compatibility = !agent && state.connectionMode === 'ssh'
  const pending = ['authenticating', 'probing', 'installing', 'handshaking'].includes(state.phase)
  const ready = state.phase === 'readyServer'
  const overview = view === 'details'
  const views: View[] = compatibility ? ['details'] : ['details', 'logs']
  const restartLabel = agent ? t('重新连接 Agent') : ready ? t('重启远端服务') : t('重试远端服务')

  return (
    <ModalOverlay onDismiss={onClose} zIndex="z-[120]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-connection`}
        className="modal-content-enter relative flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-fg shadow-elevation-3"
      >
        <header className="flex flex-shrink-0 items-start gap-3 bg-dialog-chrome px-5 pb-4 pt-5">
          <Server size={20} className="mt-0.5 flex-shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-ui-lg font-semibold text-fg">
              {t('远程连接')}
            </h2>
            <p
              id={`${id}-connection`}
              className="mt-1 break-words text-ui-sm text-fg-muted [overflow-wrap:anywhere]"
            >
              {connectionLabel}
            </p>
          </div>
          <Tooltip label={t('关闭对话框')} side="bottom">
            <button
              type="button"
              aria-label={t('关闭对话框')}
              data-modal-autofocus
              className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </Tooltip>
        </header>

        <div
          role="tablist"
          aria-label={t('连接详情')}
          className="flex flex-shrink-0 gap-5 border-b border-dialog-separator bg-dialog-chrome px-5"
        >
          {views.map(item => (
            <button
              key={item}
              id={`${id}-${item}-tab`}
              role="tab"
              type="button"
              aria-selected={view === item}
              aria-controls={`${id}-panel`}
              tabIndex={view === item ? 0 : -1}
              className={`border-b-2 px-0.5 pb-2.5 text-ui transition-colors ${view === item ? 'border-brand text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
              onClick={() => {
                if (view !== item) onViewChange(item)
              }}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? views[0]
                    : event.key === 'End'
                      ? views.at(-1)!
                      : views[
                          (views.indexOf(item) +
                            (event.key === 'ArrowLeft' ? -1 : 1) +
                            views.length) %
                            views.length
                        ]
                onViewChange(next)
                document.getElementById(`${id}-${next}-tab`)?.focus()
              }}
            >
              {item === 'details' ? t('概览') : t('服务日志')}
            </button>
          ))}
        </div>

        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${view}-tab`}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto p-5 text-ui text-fg"
        >
          {overview ? (
            <div className="space-y-4">
              <ConnectionSummary state={state} pending={pending} />
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <Detail label={t('连接模式')}>
                  {agent ? t('Agent 端口直连') : compatibility ? t('SSH 直连（兼容模式）') : t('SSH + 远端服务')}
                </Detail>
                {!compatibility && (
                  <>
                    <Detail label={t('运行方式')}>
                      {agent ? t('HTTPS / WSS') : state.transport === 'daemon'
                        ? t('常驻服务')
                        : state.transport === 'serve'
                          ? t('按项目服务')
                          : t('尚未就绪')}
                    </Detail>
                    {state.version && (
                      <Detail label={t('服务版本')}>
                        <span className="font-mono text-ui-sm">v{state.version}</span>
                      </Detail>
                    )}
                  </>
                )}
                <div className="min-w-0 sm:col-span-2">
                  <Detail label={t('项目目录')}>
                    <span className="font-mono text-ui-sm">{projectPath}</span>
                  </Detail>
                </div>
              </dl>
              {state.reason && !compatibility && (
                <details className="rounded-md border border-dialog-border bg-dialog-sidebar p-3">
                  <summary className="cursor-pointer rounded text-ui-sm font-medium text-fg focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">{t('诊断信息')}</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words font-mono text-ui-sm text-fg-muted [overflow-wrap:anywhere]">
                    {state.reason}
                  </p>
                </details>
              )}
              {blocker && (
                <p role="status" className="text-ui-sm text-warn">
                  {t(blocker)}
                </p>
              )}
              {state.timings && <TimingsDetail summary={state.timings} />}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-ui-sm text-fg-muted">
                  {t('当前项目的远端服务日志，用于排查连接和启动问题。')}
                </p>
                <button
                  type="button"
                  aria-label={t('刷新日志')}
                  disabled={logsLoading}
                  className="inline-flex flex-shrink-0 items-center gap-1.5 rounded border border-dialog-border px-2.5 py-1 text-ui-sm hover:bg-bg-hover disabled:opacity-40"
                  onClick={onRefreshLogs}
                >
                  <RefreshCw size={13} className={logsLoading ? 'animate-spin' : ''} aria-hidden />
                  {logsLoading ? t('读取日志中…') : t('刷新日志')}
                </button>
              </div>
              {logsError && (
                <div
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/5 p-3 text-ui-sm"
                >
                  <p className="font-medium text-danger">{t('日志读取失败，请重试。')}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-fg-muted [overflow-wrap:anywhere]">
                    {logsError}
                  </p>
                </div>
              )}
              <pre
                aria-busy={logsLoading}
                aria-label={t('服务日志')}
                className="min-h-48 whitespace-pre-wrap break-words rounded-md border border-dialog-border bg-dialog-input p-3 font-mono text-ui-sm leading-relaxed [overflow-wrap:anywhere]"
              >
                {logs ||
                  (logsLoading
                    ? t('正在读取远端服务日志…')
                    : logsError
                      ? t('日志暂不可用')
                      : t('暂无日志。服务启动后可刷新查看。'))}
              </pre>
            </div>
          )}
        </div>

        <footer className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-t border-dialog-separator bg-dialog-chrome px-5 py-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-ui-sm text-fg hover:bg-bg-hover"
            onClick={onSettings}
          >
            <Settings2 size={14} aria-hidden />
            {t(agent ? '直连设置' : '服务安装设置')}
          </button>
          {compatibility ? (
            <button
              type="button"
              disabled={busy}
              onClick={onEnableServer}
              className="rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-40"
            >
              {busy ? t('正在切换…') : t('启用远端服务')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !!blocker || pending}
              onClick={onRestart}
              className="inline-flex items-center gap-1.5 rounded border border-dialog-border px-3 py-1.5 text-ui text-fg hover:bg-bg-hover disabled:opacity-40"
            >
              {busy ? (
                <LoaderCircle size={14} className="animate-spin" aria-hidden />
              ) : (
                <RotateCw size={14} aria-hidden />
              )}
              {busy ? t(agent ? '正在重新连接…' : '正在重启…') : restartLabel}
            </button>
          )}
        </footer>
      </section>
    </ModalOverlay>
  )
}

function ConnectionSummary({ state, pending }: { state: SshServerState; pending: boolean }) {
  const { t } = useI18n()
  const agent = state.transport === 'agent'
  const compatibility = !agent && state.connectionMode === 'ssh'
  const offline = state.phase === 'disconnected'
  const ready = state.phase === 'readyServer'
  const title = offline
    ? t(agent ? 'Agent 连接已断开' : 'SSH 连接已断开')
    : compatibility && !pending
      ? t('已启用 SSH 兼容模式')
      : ready
        ? t('远端服务已就绪')
        : state.phase === 'authenticating'
          ? t(agent ? '正在验证 Agent 身份' : '正在验证 SSH 身份')
          : state.phase === 'probing'
            ? t('正在检查远端服务')
            : state.phase === 'installing'
              ? t('正在安装远端服务')
              : state.phase === 'handshaking'
                ? t('正在连接远端服务')
                : t('远端服务未就绪')
  const description = offline
    ? t('连接中断，请检查网络或主机后重新连接。')
    : compatibility && !pending
      ? t('通过 SSH 直接访问文件和终端，不部署远端服务。文件树不会自动刷新，终端不支持断线恢复。')
      : ready
        ? t(agent ? '文件、搜索与终端通过独立 HTTPS / WSS 端口连接远端服务，不经过 SSH。' : '文件监控、内容搜索等功能由远端服务提供，所有通信均通过 SSH。')
        : pending
          ? t('准备完成后会自动更新状态，无需重复操作。')
          : t('请查看诊断信息，检查服务安装设置后重试。')
  const Icon = pending
    ? LoaderCircle
    : ready || (compatibility && !offline)
      ? CheckCircle2
      : AlertCircle
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-md border p-3 ${ready ? 'border-ok/30 bg-ok/5' : offline ? 'border-danger/30 bg-danger/5' : 'border-dialog-border bg-dialog-sidebar'}`}
    >
      <Icon
        size={18}
        aria-hidden
        className={`mt-0.5 flex-shrink-0 ${pending ? 'animate-spin text-accent' : offline ? 'text-danger' : ready ? 'text-ok' : compatibility ? 'text-fg-muted' : 'text-warn'}`}
      />
      <div className="min-w-0">
        <h3 className={`font-semibold ${ready ? 'text-ok' : offline ? 'text-danger' : 'text-fg'}`}>
          {title}
        </h3>
        <p className="mt-1 text-ui-sm leading-relaxed text-fg-muted">{description}</p>
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-ui-sm text-dialog-label">{label}</dt>
      <dd className="break-words [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function TimingsDetail({ summary }: { summary: string }) {
  const { t } = useI18n()
  const timings = parseSshServerTimings(summary)
  if (!timings)
    return (
      <dl>
        <Detail label={t('连接耗时')}>{summary}</Detail>
      </dl>
    )
  const foreground = timings.stages.filter(stage => !stage.background)
  const background = timings.stages.filter(stage => stage.background)
  const max = Math.max(0.1, ...timings.stages.map(stage => stage.seconds))
  const slowest = foreground.reduce<SshServerTimingStage | null>(
    (worst, stage) => (worst && worst.seconds >= stage.seconds ? worst : stage),
    null
  )
  const row = (stage: SshServerTimingStage) => (
    <li
      key={`${stage.label}-${stage.background}`}
      className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_3rem] items-center gap-2"
    >
      <span className="break-words">{stage.label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-bg-hover">
        <span
          className={`block h-full rounded-full ${stage.background ? 'bg-fg-muted' : stage === slowest ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${Math.max(2, (stage.seconds / max) * 100)}%` }}
        />
      </span>
      <span className="text-right tabular-nums text-fg-muted">{stage.seconds.toFixed(1)}s</span>
    </li>
  )
  return (
    <details className="border-t border-dialog-separator pt-3">
      <summary className="cursor-pointer text-ui-sm text-fg-muted hover:text-fg">
        {timings.total !== null
          ? t('就绪用时 {seconds}s', { seconds: timings.total.toFixed(1) })
          : t('连接耗时')}
      </summary>
      <div className="mt-3 space-y-2 text-ui-sm">
        <ul className="space-y-2" aria-label={t('分阶段耗时')}>
          {foreground.map(row)}
        </ul>
        {background.length > 0 && (
          <>
            <p className="pt-1 text-fg-muted">{t('后台（不计入就绪用时）')}</p>
            <ul className="space-y-2">{background.map(row)}</ul>
          </>
        )}
      </div>
    </details>
  )
}
