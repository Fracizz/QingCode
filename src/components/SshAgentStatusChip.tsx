import { useEffect, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import {
  isAgentCommandUnavailable,
  parseSshAgentState,
  sshAgentChip,
  sshAgentEventMatches,
  sshAgentPhaseKey,
  sshAgentTipLines,
  sshAgentTransportKey,
  type SshAgentState,
} from '../lib/sshAgentStatus'
import StatusTip from './StatusTip'
import ContextMenu from './ContextMenu'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { X } from 'lucide-react'

const STATUS_ACTION = 'rounded px-1 -mx-1 text-fg hover:bg-bg-hover transition-colors'

type DialogKind = 'details' | 'logs'

export default function SshAgentStatusChip({ rootUri }: { rootUri: string }) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const [state, setState] = useState<SshAgentState | null>(null)
  const [hidden, setHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [logs, setLogs] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: UnlistenFn | undefined
    const apply = (value: unknown) => {
      const next = parseSshAgentState(value)
      if (!next || cancelled || !sshAgentEventMatches(next.rootUri, rootUri)) return
      setHidden(false)
      setState(next)
    }
    void safeInvoke<unknown>('读取 SSH Agent 状态', 'ssh_agent_info', { rootUri })
      .then(apply)
      .catch(error => {
        if (cancelled) return
        if (isAgentCommandUnavailable(error)) {
          setHidden(true)
          setState(null)
          return
        }
        setState({
          connectionId: '',
          rootUri,
          phase: 'readyDirect',
          mode: 'direct',
          version: null,
          transport: 'direct',
          reason: String(error),
        })
      })
    void listen<unknown>('ssh-agent-state', event => apply(event.payload)).then(stop => {
      if (cancelled) stop()
      else unlisten = stop
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [rootUri])

  const chip = hidden ? null : sshAgentChip(state)
  if (!chip || !state) return null

  const tip = sshAgentTipLines(state).map(line => translateTipLine(line, t)).join('\n')

  const openLogs = () => {
    setDialog('logs')
    setLogs('')
    void safeInvoke<{ text: string }>('读取 SSH Agent 日志', 'ssh_agent_logs', { rootUri })
      .then(result => setLogs(result.text))
      .catch(error => {
        if (isAgentCommandUnavailable(error)) return
        pushToast('error', t('读取 Agent 日志失败: {error}', { error: String(error) }))
        setDialog(null)
      })
  }

  const restart = () => {
    if (busy) return
    setBusy(true)
    void safeInvoke<unknown>('重启 SSH Agent', 'ssh_agent_restart', { rootUri })
      .then(value => {
        const next = parseSshAgentState(value)
        if (next) setState(next)
      })
      .catch(error => {
        if (!isAgentCommandUnavailable(error)) {
          pushToast('error', t('重启 Agent 失败: {error}', { error: String(error) }))
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      <StatusTip label={tip}>
        <button
          type="button"
          className={`inline-flex flex-shrink-0 items-center text-ui-2xs ${STATUS_ACTION}`}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.top })
          }}
        >
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
            { label: t('查看 Agent 详情'), action: () => setDialog('details') },
            { label: t('重启 Agent'), disabled: busy, action: restart },
            { label: t('查看 Agent 日志'), action: openLogs },
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
                {dialog === 'logs' ? t('Agent 日志') : t('Agent 详情')}
              </h2>
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
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-ui text-fg">
              {dialog === 'details' ? (
                <dl className="space-y-2">
                  <Detail label={t('阶段')} value={phaseText(sshAgentPhaseKey(state.phase), t)} />
                  <Detail label={t('模式')} value={modeText(state.mode, t)} />
                  <Detail label={t('版本')} value={state.version ?? t('未知')} />
                  <Detail label={t('传输')} value={transportText(sshAgentTransportKey(state.transport), t)} />
                  {state.reason ? <Detail label={t('原因')} value={state.reason} /> : null}
                </dl>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-ui-2xs text-fg">
                  {logs || t('没有日志')}
                </pre>
              )}
            </div>
          </section>
        </ModalOverlay>
      )}
    </>
  )
}

function ChipText({ chip }: { chip: NonNullable<ReturnType<typeof sshAgentChip>> }) {
  const { t } = useI18n()
  if (chip.kind === 'version') return <>{t('Agent v{version}', { version: chip.version })}</>
  if (chip.kind === 'agent') return <>{t('Agent')}</>
  if (chip.kind === 'direct') return <>{t('直连')}</>
  return <>{t('Agent…')}</>
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
    case 'Agent v{version}':
      return t('Agent v{version}', line.params)
    case 'Agent':
      return t('Agent')
    case '传输：{transport}':
      return t('传输：{transport}', { transport: transportText(line.params?.transport, t) })
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
  mode: SshAgentState['mode'],
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (mode === 'agent') return t('Agent')
  if (mode === 'direct') return t('直连')
  return t('未知')
}
