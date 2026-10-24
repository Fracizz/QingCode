import { useEffect, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import {
  isAgentCommandUnavailable,
  parseSshServerState,
  sshServerChip,
  sshServerEventMatches,
  sshServerPhaseKey,
  sshServerTipLines,
  sshServerTransportKey,
  type SshServerChip,
  type SshServerState,
} from '../lib/sshServerStatus'
import StatusTip from './StatusTip'
import ContextMenu from './ContextMenu'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { RefreshCw, RotateCw, ScrollText, X } from 'lucide-react'

const STATUS_ACTION = 'rounded px-1 -mx-1 text-fg hover:bg-bg-hover transition-colors'
const CHIP_DOT = 'h-[5px] w-[5px] rounded-full ring-1 ring-white/10'

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
    const apply = (value: unknown) => {
      const next = parseSshServerState(value)
      if (!next || cancelled || !sshServerEventMatches(next.rootUri, rootUri)) return
      setHidden(false)
      setInfoError(null)
      setState(next)
    }
    void safeInvoke<unknown>('读取 SSH Agent 状态', 'ssh_server_info', { rootUri })
      .then(apply)
      .catch(error => {
        if (cancelled) return
        if (isAgentCommandUnavailable(error)) {
          setHidden(true)
          setState(null)
          return
        }
        // 查询失败时不能伪装成直连：以独立错误态展示，等状态事件恢复。
        setState(null)
        setInfoError(String(error))
      })
    void listen<unknown>('ssh-server-state', event => apply(event.payload)).then(stop => {
      if (cancelled) stop()
      else unlisten = stop
    })
    return () => {
      cancelled = true
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

  const restart = () => {
    if (busy) return
    setBusy(true)
    void safeInvoke<unknown>('重启 SSH Agent', 'ssh_server_restart', { rootUri })
      .then(value => {
        const next = parseSshServerState(value)
        if (next) setState(next)
        pushToast('success', t('已重启远端服务'))
      })
      .catch(error => {
        if (!isAgentCommandUnavailable(error)) {
          pushToast('error', t('重启 Server 失败: {error}', { error: String(error) }))
        }
      })
      .finally(() => setBusy(false))
  }

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
            { label: t('重启 Server'), disabled: busy, action: restart },
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
                    <Tooltip label={t('重启 Server')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('重启 Server')}
                        disabled={busy}
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
                </dl>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-ui-2xs text-fg">
                  {logsLoading ? t('读取日志中…') : logs || t('没有日志')}
                </pre>
              )}
            </div>
          </section>
        </ModalOverlay>
      )}
    </>
  )
}

function ChipDot({ kind }: { kind: SshServerChip['kind'] }) {
  const tone =
    kind === 'agent' ? 'bg-accent' : kind === 'pending' ? 'bg-warn animate-pulse' : 'bg-fg-muted'
  return <span aria-hidden className={`${CHIP_DOT} ${tone}`} />
}

function ChipText({ chip }: { chip: SshServerChip }) {
  const { t } = useI18n()
  if (chip.kind === 'agent') return <>{t('Server')}</>
  if (chip.kind === 'direct') return <>{t('直连')}</>
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
  if (mode === 'agent') return t('Server')
  if (mode === 'direct') return t('直连')
  return t('未知')
}
