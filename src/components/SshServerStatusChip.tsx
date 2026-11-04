import { hasBackend } from '../lib/runtimeCapabilities'
import { useConnectionLatency } from '../lib/useConnectionLatency'
import { invalidateConnectionLatency } from '../lib/connectionLatency'
import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { AlertCircle } from 'lucide-react'
import { safeInvoke } from '../lib/tauri'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  isAgentCommandUnavailable,
  parseSshServerState,
  sshServerChip,
  sshServerEventMatches,
  sshServerIsDirect,
  sshServerModeKey,
  sshServerSwitchBlocker,
  sshServerTipLines,
  type SshServerChip,
  type SshServerState,
} from '../lib/sshServerStatus'
import StatusTip from './StatusTip'
import ContextMenu from './ContextMenu'
import SshServerDialog from './SshServerDialog'
import DirectAgentConnectionPanel from './DirectAgentConnectionPanel'
import DirectSshFallback from './DirectSshFallback'
import { directAgentApi, type DirectAgentInfo } from '../lib/directAgent'
import { confirmDialog } from '../store/confirmStore'
import { confirmSshServerRestart } from '../lib/sshWindowsRepair'
import { serverModeErrorAction } from '../lib/serverModeError'
import { switchSshConnectionMode, sshConnectionLabel, sshRemoteDisplayPath, sshRemotePathFromUri, SSH_CONNECTION_INVALIDATED_EVENT, SSH_CONNECTION_DISCONNECTED_EVENT, isSshBackgroundSuspended, reconnectSshConnection } from '../lib/sshWorkspace'

const STATUS_ACTION = 'status-action status-connection'
const CHIP_DOT = 'status-connection-dot'
/** Preparation needs faster checks; settled connections still refresh every 5 seconds. */
const SSH_SERVER_PENDING_POLL_MS = 1500

type DialogKind = 'details' | 'logs' | 'agent'

export default function SshServerStatusChip({ rootUri }: { rootUri: string }) {
  return <SshServerStatus key={rootUri} rootUri={rootUri} />
}

function SshServerStatus({ rootUri }: { rootUri: string }) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const sshConnections = useProjectStore(s => s.sshConnections)
  const [state, setState] = useState<SshServerState | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState<string | null>(null)
  const logsRequest = useRef(0)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [fallbackInfo, setFallbackInfo] = useState<DirectAgentInfo | null>(null)
  const showLatency = !hidden && !infoError && state?.transport === 'agent' && state.phase === 'readyServer'
  const latency = useConnectionLatency(showLatency && hasBackend() ? rootUri : null)
  const latencyText = latency.milliseconds === null ? '-- ms' : `${Math.max(1, Math.round(latency.milliseconds))} ms`

  useEffect(() => {
    let cancelled = false
    if (dialog && state?.transport === 'agent') {
      void directAgentApi.info(state.connectionId).then(info => { if (!cancelled) setFallbackInfo(info) }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [dialog, state?.connectionId, state?.transport, refreshKey])

  useEffect(() => () => { logsRequest.current += 1 }, [])

  useEffect(() => {
    if (!hasBackend()) return
    let cancelled = false
    let unlisten: UnlistenFn | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    // 每收到一条状态事件递增。查询发出后若有事件到达，查询结果即为旧快照，
    // 必须丢弃，否则晚到的「正在探测」会覆盖已收到的「已就绪」。
    let eventSeq = 0
    let querySeq = 0
    const parse = (value: unknown) => {
      const next = parseSshServerState(value)
      return next && sshServerEventMatches(next.rootUri, rootUri) ? next : null
    }
    const accept = (next: SshServerState) => {
      if (next.transport !== 'agent' || next.phase !== 'readyServer') invalidateConnectionLatency(rootUri)
      setHidden(false)
      setInfoError(null)
      setState(next)
      // 中间阶段补查：最终状态事件一旦漏掉，后端按快照去重不会再发。
      clearTimeout(pollTimer)
      pollTimer = undefined
      pollTimer = setTimeout(() => void query(), sshServerChip(next)?.kind === 'pending' ? SSH_SERVER_PENDING_POLL_MS : 5000)
    }
    const invalidate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== rootUri.split('/')[2]) return
      eventSeq += 1
      clearTimeout(pollTimer)
      setHidden(false)
      setInfoError(null)
      setState(previous => ({ connectionId: rootUri.split('/')[2], rootUri, connectionMode: 'server', transport: useProjectStore.getState().sshConnections.find(c => c.id === rootUri.split('/')[2])?.agentEndpoint ? 'agent' : null, ...previous, phase: 'disconnected', mode: 'unknown', version: null, reason: null, timings: null }))
    }
    const query = async () => {
      if (isSshBackgroundSuspended(rootUri.split('/')[2])) return
      if (document.visibilityState === 'hidden') {
        clearTimeout(pollTimer)
        pollTimer = setTimeout(() => void query(), 5000)
        return
      }
      const seq = eventSeq
      const request = ++querySeq
      let value: unknown
      try {
        value = await safeInvoke<unknown>('读取 SSH Server 状态', 'ssh_server_info', { rootUri })
      } catch (error) {
        if (cancelled || seq !== eventSeq || request !== querySeq) return
        if (isAgentCommandUnavailable(error)) {
          setHidden(true)
          setState(null)
          return
        }
        // 查询失败时不能伪装成直连：以独立错误态展示，等状态事件恢复。
        setState(null)
        setInfoError(String(error))
        clearTimeout(pollTimer)
        pollTimer = setTimeout(() => void query(), 5000)
        return
      }
      if (cancelled || seq !== eventSeq || request !== querySeq) return
      const next = parse(value)
      if (next) accept(next)
    }
    void (async () => {
      // 先订阅再查询：查询返回前完成的部署只会发一次事件，订阅晚了就永远收不到。
      try {
        const stop = await listen<unknown>('ssh-server-state', event => {
          const next = parse(event.payload)
          if (!next || cancelled) return
          if (next.phase !== 'disconnected' && isSshBackgroundSuspended(next.connectionId)) return
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
      if (!cancelled) {
        if (isSshBackgroundSuspended(rootUri.split('/')[2])) invalidate(new CustomEvent(SSH_CONNECTION_INVALIDATED_EVENT, { detail: rootUri.split('/')[2] }))
        else await query()
      }
    })()
    const refresh = () => { if (document.visibilityState !== 'hidden') void query() }
    window.addEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
    window.addEventListener(SSH_CONNECTION_DISCONNECTED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      cancelled = true
      clearTimeout(pollTimer)
      unlisten?.()
      window.removeEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
      window.removeEventListener(SSH_CONNECTION_DISCONNECTED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [rootUri, refreshKey])

  if (hidden) return null

  if (infoError) {
    return (
      <StatusTip label={`${t('远端服务状态未知')}\n${infoError}\n${t('点击重试')}`}>
        <button
          type="button"
          className={`inline-flex flex-shrink-0 items-center gap-1.5 text-ui-sm ${STATUS_ACTION}`}
          data-tone="pending"
          aria-label={t('远端服务状态未知')}
          onClick={() => setRefreshKey(key => key + 1)}
        >
          <AlertCircle size={13} className="text-warn" aria-hidden />
          <span className="truncate">{t('服务状态未知')}</span>
        </button>
      </StatusTip>
    )
  }

  const chip = sshServerChip(state)
  if (!chip || !state) return null

  const tipLines = [
    ...sshServerTipLines(state).map(line => translateTipLine(line, t)),
    ...(showLatency ? [
      t('往返延迟：{latency}', { latency: latencyText }),
      ...(latency.checkedAt === null ? [] : [t('测量时间：{time}', { time: new Date(latency.checkedAt).toLocaleTimeString() })]),
      t('每 30 秒更新，窗口隐藏时暂停'),
    ] : []),
    t('点击查看详情'),
  ]
  const tip = tipLines.join('\n')

  const fetchLogs = () => {
    const request = ++logsRequest.current
    setLogsError(null)
    setLogsLoading(true)
    void safeInvoke<{ text: string }>('读取 SSH Server 日志', 'ssh_server_logs', { rootUri })
      .then(result => {
        if (request === logsRequest.current) setLogs(result.text)
      })
      .catch(error => {
        if (request === logsRequest.current) setLogsError(String(error))
      })
      .finally(() => {
        if (request === logsRequest.current) setLogsLoading(false)
      })
  }

  const openLogs = () => {
    setDialog('logs')
    fetchLogs()
  }

  const agent = state.transport === 'agent'
  const sshMode = !agent && state.connectionMode === 'ssh'
  const direct = sshServerIsDirect(state)
  const switchBlocker = !sshMode && direct ? sshServerSwitchBlocker(state) : null

  const enableServerMode = async () => {
    if (busy || !state) return
    const connectionId = state.connectionId
    const connection = sshConnections.find(item => item.id === connectionId)
    const name = connection ? sshConnectionLabel(connection) : connectionId
    setBusy(true)
    try {
      const accepted = await confirmDialog({
        title: t('启用远端服务'),
        message: t('将断开并重新连接 {name}，并部署远端服务。当前直连终端将被关闭。', { name }),
        kind: 'warning',
        confirmLabel: t('启用并重连'),
        cancelLabel: t('取消'),
      })
      if (!accepted) return
      await switchSshConnectionMode(connectionId, 'server')
      pushToast('success', t('已启用远端服务，正在重新连接'))
    } catch (error) {
      pushToast(
        'error',
        t('启用远端服务失败: {error}', { error: String(error) }),
      )
    } finally {
      setBusy(false)
    }
  }

  // 重建 daemon 会结束托管终端，必须先说明影响并确认。
  const restart = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (agent && state.phase === 'disconnected') {
        await reconnectSshConnection(state.connectionId)
        setRefreshKey(key => key + 1)
        return
      }
      const accepted = agent || await confirmSshServerRestart(rootUri, t)
      if (!accepted) return
      const value = await safeInvoke<unknown>(agent ? '重新连接 Server' : '重启 SSH Server', 'ssh_server_restart', { rootUri })
      const next = parseSshServerState(value)
      if (next) setState(next)
      if (next?.phase === 'readyServer') {
        pushToast('success', t(agent ? '已重新连接 Server' : '已重启远端服务'))
      } else if (next && sshServerIsDirect(next)) {
        pushToast('warn', t('远端服务尚未就绪'), next.reason ?? undefined)
      } else {
        pushToast('info', t('正在部署远端服务…'))
      }
    } catch (error) {
      if (isAgentCommandUnavailable(error)) return
      pushToast('error', t(agent ? '重新连接 Server 失败: {error}' : '重启远端服务失败: {error}', { error: String(error) }))
    } finally {
      setBusy(false)
    }
  }
  const restartLabel = t(agent ? '重新连接 Server' : '重启远端服务')
  const connection = sshConnections.find(item => item.id === state.connectionId)
  const standaloneAgent = Boolean(connection && connection.username === 'Agent' && connection.auth_kind === 'password' && /^[a-f\d]{64}$/i.test(connection.host_key_fingerprint))

  return (
    <>
      <StatusTip label={tip}>
        <button
          type="button"
          className={`inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-ui-sm ${STATUS_ACTION}`}
          data-tone={chip.kind}
          aria-label={tipLines.join(' ')}
          onClick={() => setDialog('details')}
          onContextMenu={event => {
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <ChipDot kind={chip.kind} />
          <span className="truncate">{t(sshServerModeKey(state))}</span>
          {showLatency && <span className="shrink-0 tabular-nums text-fg-muted">{latencyText}</span>}
        </button>
      </StatusTip>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          preferAbove
          onClose={() => setMenu(null)}
          items={[
            { label: t('查看远端服务详情'), action: () => setDialog('details') },
            ...(sshMode
              ? [
                  {
                    label: t('启用远端服务'),
                    disabled: busy,
                    action: () => void enableServerMode(),
                  },
                ]
              : [
                  { label: restartLabel, disabled: busy || !!switchBlocker, action: restart },
                  { label: t('查看远端服务日志'), action: openLogs },
                ]),
          ]}
        />
      )}
      {dialog && (
        <SshServerDialog
          state={state}
          connectionLabel={connection ? agent ? connection.name : sshConnectionLabel(connection) : t('远程项目')}
          projectPath={sshRemoteDisplayPath(sshRemotePathFromUri(rootUri))}
          view={sshMode && dialog === 'logs' ? 'details' : dialog}
          agentPanel={connection && <DirectAgentConnectionPanel
            key={connection.id}
            connectionId={connection.id}
            defaultHost={connection.host}
            standalone={standaloneAgent}
            initiallyOpen
            onUpdated={async info => {
              if (standaloneAgent) {
                try {
                  await useProjectStore.getState().saveSshConnection({ ...connection, host: info.host, host_key_fingerprint: info.certificateFingerprint, updated_at: Date.now() })
                } catch {
                  throw new Error('[direct:record] Server connection row could not be saved')
                }
              } else {
                await useProjectStore.getState().loadSshConnections()
              }
              setLogs('')
              logsRequest.current += 1
              setRefreshKey(key => key + 1)
            }}
          />}
          fallbackPanel={agent && connection && fallbackInfo?.enabled && <DirectSshFallback connection={connection} info={fallbackInfo} disabled={busy} onConfigure={() => setDialog(null)} onSwitched={async info => {
            setFallbackInfo(info)
            await useProjectStore.getState().loadSshConnections()
            await reconnectSshConnection(connection.id)
            setRefreshKey(key => key + 1)
          }} />}
          busy={busy}
          blocker={switchBlocker}
          logs={logs}
          logsLoading={logsLoading}
          logsError={logsError}
          onViewChange={view => {
            if (view === 'logs') openLogs()
            else setDialog(view)
          }}
          onRefreshLogs={fetchLogs}
          onRestart={() => void restart()}
          onUpdate={() => {
            if (agent) useUIStore.setState({ serverUpdateRootUri: rootUri })
            else void serverModeErrorAction(`Server 模式：${state.reason}`, rootUri, t)?.onAction()
          }}
          onEnableServer={() => void enableServerMode()}
          onSettings={() => {
            if (agent && connection) {
              setDialog('agent')
              return
            }
            setDialog(null)
            if (agent) useUIStore.getState().openRemoteConnections()
            else useUIStore.getState().requestSettings('ssh.server')
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

function ChipDot({ kind }: { kind: SshServerChip['kind'] }) {
  const tone =
    kind === 'agent'
      ? 'bg-ok'
      : kind === 'pending'
        ? 'bg-warn animate-pulse'
        : kind === 'error'
          ? 'bg-warn'
        : kind === 'offline'
          ? 'bg-danger'
          : 'bg-fg-muted'
  return <span aria-hidden className={`${CHIP_DOT} ${tone}`} />
}

function translateTipLine(
  line: { key: string; params?: Record<string, string> },
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  switch (line.key) {
    case 'SSH 模式（连接配置）':
      return t('SSH 模式（连接配置）')
    case '运行方式：{transport}':
      return t('运行方式：{transport}', {
        transport: t(line.params?.transport ?? '未知'),
      })
    case '回退原因：{reason}':
      return t('回退原因：{reason}', line.params)
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
