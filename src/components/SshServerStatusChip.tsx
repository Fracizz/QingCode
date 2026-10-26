import { useEffect, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import {
  isAgentCommandUnavailable,
  parseSshServerState,
  parseSshServerTimings,
  sshServerChip,
  sshServerCanSwitchToSshMode,
  sshServerEventMatches,
  sshServerDisabledBySetting,
  sshServerIsDirect,
  sshServerSwitchBlocker,
  sshServerPhaseKey,
  sshServerTipLines,
  sshServerTransportKey,
  type SshServerChip,
  type SshServerState,
  type SshServerTimingStage,
} from '../lib/sshServerStatus'
import StatusTip from './StatusTip'
import ContextMenu from './ContextMenu'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { switchToServerMode, switchToSshMode } from '../lib/serverModeError'
import { RefreshCw, RotateCw, ScrollText, X } from 'lucide-react'

const STATUS_ACTION = 'rounded px-1 -mx-1 text-fg hover:bg-bg-hover transition-colors'
const CHIP_DOT = 'h-[5px] w-[5px] rounded-full ring-1 ring-white/10'
/** 探测/安装/握手期间的补查间隔；最终状态到达后停止。 */
const SSH_SERVER_PENDING_POLL_MS = 1500

type DialogKind = 'details' | 'logs'

export default function SshServerStatusChip({ rootUri }: { rootUri: string }) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const [state, setState] = useState<SshServerState | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: UnlistenFn | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    // 每收到一条状态事件递增。查询发出后若有事件到达，查询结果即为旧快照，
    // 必须丢弃，否则晚到的「正在探测」会覆盖已收到的「已就绪」。
    let eventSeq = 0
    const parse = (value: unknown) => {
      const next = parseSshServerState(value)
      return next && sshServerEventMatches(next.rootUri, rootUri) ? next : null
    }
    const accept = (next: SshServerState) => {
      setHidden(false)
      setInfoError(null)
      setState(next)
      // 中间阶段补查：最终状态事件一旦漏掉，后端按快照去重不会再发。
      clearTimeout(pollTimer)
      pollTimer = undefined
      if (sshServerChip(next)?.kind === 'pending') {
        pollTimer = setTimeout(() => void query(), SSH_SERVER_PENDING_POLL_MS)
      }
    }
    const query = async () => {
      const seq = eventSeq
      let value: unknown
      try {
        value = await safeInvoke<unknown>('读取 SSH Agent 状态', 'ssh_server_info', { rootUri })
      } catch (error) {
        if (cancelled || seq !== eventSeq) return
        if (isAgentCommandUnavailable(error)) {
          setHidden(true)
          setState(null)
          return
        }
        // 查询失败时不能伪装成直连：以独立错误态展示，等状态事件恢复。
        setState(null)
        setInfoError(String(error))
        return
      }
      if (cancelled || seq !== eventSeq) return
      const next = parse(value)
      if (next) accept(next)
    }
    void (async () => {
      // 先订阅再查询：查询返回前完成的部署只会发一次事件，订阅晚了就永远收不到。
      try {
        const stop = await listen<unknown>('ssh-server-state', event => {
          const next = parse(event.payload)
          if (!next || cancelled) return
          eventSeq += 1
          accept(next)
        })
        if (cancelled) {
          stop()
          return
        }
        unlisten = stop
      } catch {
        // 订阅失败仍靠查询 + 中间阶段补查收口。
      }
      if (!cancelled) await query()
    })()
    return () => {
      cancelled = true
      clearTimeout(pollTimer)
      unlisten?.()
    }
  }, [rootUri])

  if (hidden) return null

  if (infoError) {
    return (
      <StatusTip label={`${t('Server 状态未知')}\n${infoError}`}>
        <button
          type="button"
          className={`inline-flex flex-shrink-0 items-center text-ui-2xs ${STATUS_ACTION}`}
          aria-label={t('Server 状态未知')}
        >
          !
        </button>
      </StatusTip>
    )
  }

  const chip = sshServerChip(state)
  if (!chip || !state) return null

  const tipLines = [
    ...sshServerTipLines(state).map(line => translateTipLine(line, t)),
    t('点击查看详情'),
  ]
  const tip = tipLines.join('\n')

  const fetchLogs = () => {
    setLogs('')
    setLogsLoading(true)
    void safeInvoke<{ text: string }>('读取 SSH Agent 日志', 'ssh_server_logs', { rootUri })
      .then(result => setLogs(result.text))
      .catch(error => {
        if (isAgentCommandUnavailable(error)) return
        pushToast('error', t('读取 Server 日志失败: {error}', { error: String(error) }))
      })
      .finally(() => setLogsLoading(false))
  }

  const openLogs = () => {
    setDialog('logs')
    fetchLogs()
  }

  const direct = sshServerIsDirect(state)
  const canSwitchToSsh = sshServerCanSwitchToSshMode(state)
  // SSH 模式（设置关闭）下「切换到 Server」直接先开启设置，不再要求去设置页。
  const disabledBySetting = direct && sshServerDisabledBySetting(state)
  const switchBlocker = direct && !disabledBySetting ? sshServerSwitchBlocker(state) : null

  const switchModeToSsh = () => {
    if (busy) return
    setBusy(true)
    void switchToSshMode()
      .then(() => pushToast('success', t('已切换到 SSH 模式')))
      .catch(error => {
        pushToast('error', t('切到 SSH 模式失败: {error}', { error: String(error) }))
      })
      .finally(() => setBusy(false))
  }

  // 直连时同一个后端命令（清缓存 + 重新发现/部署）即「切换到 Server」。
  const restart = () => {
    if (busy) return
    setBusy(true)
    void (disabledBySetting ? switchToServerMode() : Promise.resolve())
      .then(() => safeInvoke<unknown>('重启 SSH Agent', 'ssh_server_restart', { rootUri }))
      .then(value => {
        const next = parseSshServerState(value)
        if (next) setState(next)
        if (!direct) {
          pushToast('success', t('已重启远端服务'))
        } else if (next?.phase === 'readyServer') {
          pushToast('success', t('已切换到 Server'))
        } else if (next && sshServerIsDirect(next)) {
          pushToast('warn', t('仍为直连'), next.reason ?? undefined)
        } else {
          pushToast('info', t('正在部署远端服务…'))
        }
      })
      .catch(error => {
        if (isAgentCommandUnavailable(error)) return
        pushToast(
          'error',
          direct
            ? t('切换到 Server 失败: {error}', { error: String(error) })
            : t('重启 Server 失败: {error}', { error: String(error) }),
        )
      })
      .finally(() => setBusy(false))
  }
  const restartLabel = direct ? t('切换到 Server') : t('重启 Server')

  return (
    <>
      <StatusTip label={tip}>
        <button
          type="button"
          className={`inline-flex flex-shrink-0 items-center gap-1.5 text-ui-2xs ${STATUS_ACTION}`}
          aria-label={tipLines.join(' ')}
          onClick={() => setDialog('details')}
          onContextMenu={event => {
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <ChipDot kind={chip.kind} />
          <ChipText chip={chip} />
        </button>
      </StatusTip>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          preferAbove
          onClose={() => setMenu(null)}
          items={[
            { label: t('查看 Server 详情'), action: () => setDialog('details') },
            { label: restartLabel, disabled: busy || !!switchBlocker, action: restart },
            ...(canSwitchToSsh
              ? [{ label: t('切到 SSH 模式'), disabled: busy, action: switchModeToSsh }]
              : []),
            { label: t('查看 Server 日志'), action: openLogs },
          ]}
        />
      )}
      {dialog && (
        <ModalOverlay onDismiss={() => setDialog(null)} zIndex="z-[120]">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="ssh-agent-dialog-title"
            className="modal-content-enter relative flex max-h-[min(70vh,520px)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-elevation-3"
          >
            <header className="flex h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-4">
              <h2 id="ssh-agent-dialog-title" className="text-ui-lg font-medium text-fg">
                {dialog === 'logs' ? t('Server 日志') : t('Server 详情')}
              </h2>
              <div className="flex items-center gap-1">
                {dialog === 'details' ? (
                  <>
                    <Tooltip label={restartLabel} side="bottom">
                      <button
                        type="button"
                        aria-label={restartLabel}
                        disabled={busy || !!switchBlocker}
                        className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                        onClick={restart}
                      >
                        <RotateCw size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('查看 Server 日志')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('查看 Server 日志')}
                        className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
                        onClick={openLogs}
                      >
                        <ScrollText size={16} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip label={t('刷新')} side="bottom">
                    <button
                      type="button"
                      aria-label={t('刷新')}
                      disabled={logsLoading}
                      className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                      onClick={fetchLogs}
                    >
                      <RefreshCw size={16} />
                    </button>
                  </Tooltip>
                )}
                <Tooltip label={t('关闭')} side="bottom">
                  <button
                    type="button"
                    aria-label={t('关闭')}
                    className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
                    onClick={() => setDialog(null)}
                  >
                    <X size={16} />
                  </button>
                </Tooltip>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-ui text-fg">
              {dialog === 'details' ? (
                <dl className="space-y-2">
                  <Detail label={t('阶段')} value={phaseText(sshServerPhaseKey(state.phase), t)} />
                  <Detail label={t('模式')} value={modeText(state.mode, t)} />
                  <Detail label={t('版本')} value={state.version ?? t('未知')} />
                  <Detail label={t('传输')} value={transportText(sshServerTransportKey(state.transport), t)} />
                  {state.reason ? <Detail label={t('原因')} value={state.reason} /> : null}
                  {state.timings ? <TimingsDetail summary={state.timings} /> : null}
                </dl>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-ui-2xs text-fg">
                  {logsLoading ? t('读取日志中…') : logs || t('没有日志')}
                </pre>
              )}
            </div>
            {dialog === 'details' ? (
              <footer className="flex flex-shrink-0 items-center justify-end gap-3 border-t border-border px-4 py-3">
                {direct ? (
                  <>
                    {switchBlocker ? (
                      <p className="min-w-0 flex-1 text-ui-xs text-fg-muted">{t(switchBlocker)}</p>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy || !!switchBlocker}
                      className="flex-shrink-0 rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-40"
                      onClick={restart}
                    >
                      {busy ? t('正在切换…') : t('切换到 Server')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    className="flex-shrink-0 rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-40"
                    onClick={switchModeToSsh}
                  >
                    {busy ? t('正在切换…') : t('切到 SSH 模式')}
                  </button>
                )}
              </footer>
            ) : null}
          </section>
        </ModalOverlay>
      )}
    </>
  )
}

function ChipDot({ kind }: { kind: SshServerChip['kind'] }) {
  const tone =
    kind === 'agent'
      ? 'bg-accent'
      : kind === 'pending'
        ? 'bg-warn animate-pulse'
        : kind === 'offline'
          ? 'bg-danger'
          : 'bg-fg-muted'
  return <span aria-hidden className={`${CHIP_DOT} ${tone}`} />
}

function ChipText({ chip }: { chip: SshServerChip }) {
  const { t } = useI18n()
  if (chip.kind === 'agent') return <>{t('Server')}</>
  if (chip.kind === 'direct') return <>{t('直连')}</>
  if (chip.kind === 'offline') return <>{t('已断开')}</>
  return <>{t('Server…')}</>
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 flex-shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

/** 耗时拆成分阶段条形图：最慢的前台阶段高亮，后台阶段（不计入合计）另起一组。 */
function TimingsDetail({ summary }: { summary: string }) {
  const { t } = useI18n()
  const timings = parseSshServerTimings(summary)
  if (!timings) return <Detail label={t('耗时')} value={summary} />
  const foreground = timings.stages.filter(stage => !stage.background)
  const background = timings.stages.filter(stage => stage.background)
  const max = Math.max(0.1, ...timings.stages.map(stage => stage.seconds))
  const slowest = foreground.reduce<SshServerTimingStage | null>(
    (worst, stage) => (worst && worst.seconds >= stage.seconds ? worst : stage),
    null,
  )
  const row = (stage: SshServerTimingStage) => (
    <li key={`${stage.label}-${stage.background}`} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-2">
      <span className={`truncate ${stage.seconds < 0.05 ? 'text-fg-muted' : ''}`}>{stage.label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-bg-hover">
        <span
          className={`block h-full rounded-full ${
            stage.background ? 'bg-fg-muted' : stage === slowest ? 'bg-warn' : 'bg-accent'
          }`}
          style={{ width: `${Math.max(2, (stage.seconds / max) * 100)}%` }}
        />
      </span>
      <span className="text-right tabular-nums text-fg-dim">{stage.seconds.toFixed(1)}s</span>
    </li>
  )
  return (
    <div className="flex gap-3">
      <dt className="w-16 flex-shrink-0 text-fg-muted">{t('耗时')}</dt>
      <dd className="min-w-0 flex-1 space-y-1.5 text-ui-xs">
        {timings.total !== null ? (
          <p className="text-ui text-fg">
            {t('就绪用时 {seconds}s', { seconds: timings.total.toFixed(1) })}
          </p>
        ) : null}
        <ul className="space-y-1" aria-label={t('分阶段耗时')}>
          {foreground.map(row)}
        </ul>
        {background.length > 0 ? (
          <>
            <p className="pt-1 text-fg-muted">{t('后台（不计入就绪用时）')}</p>
            <ul className="space-y-1">{background.map(row)}</ul>
          </>
        ) : null}
      </dd>
    </div>
  )
}

function translateTipLine(
  line: { key: string; params?: Record<string, string> },
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  switch (line.key) {
    case '直连：{reason}':
      return t('直连：{reason}', line.params)
    case '直连':
      return t('直连')
    case 'Server v{version}':
      return t('Server v{version}', line.params)
    case 'Server':
      return t('Server')
    case '阶段：{phase}':
      return t('阶段：{phase}', { phase: phaseText(line.params?.phase, t) })
    case '原因：{reason}':
      return t('原因：{reason}', line.params)
    default:
      return t(line.key, line.params)
  }
}

function phaseText(
  key: string | undefined,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  switch (key) {
    case '未连接':
      return t('未连接')
    case '正在认证':
      return t('正在认证')
    case '正在探测':
      return t('正在探测')
    case '正在安装':
      return t('正在安装')
    case '正在握手':
      return t('正在握手')
    case '已就绪':
      return t('已就绪')
    case '直连':
      return t('直连')
    default:
      return t('未知')
  }
}

function transportText(
  key: string | null | undefined,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (key === '常驻 daemon') return t('常驻 daemon')
  if (key === '项目 serve') return t('项目 serve')
  if (key === '直连') return t('直连')
  return t('未知')
}

function modeText(
  mode: SshServerState['mode'],
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (mode === 'server') return t('Server')
  if (mode === 'direct') return t('直连')
  return t('未知')
}
