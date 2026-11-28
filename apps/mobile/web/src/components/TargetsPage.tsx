import { t, translateMessage } from '@qn/codex-client'
import { FolderOpen, PlugZap, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatAddress } from '../link'
import { connectionName } from '../names'
import { useApp } from '../store'
import type { TargetState } from '../types'
import { Badge, Button, Dialog, Empty, Header, Loading, Note, SheetAction, StatusDot } from './ui'
import { TargetRateLimits } from './RateLimitView'
import { WorkspaceIcon } from './WorkspaceHome'

const stateText: Record<TargetState, string> = {
  idle: t('未连接'),
  connecting: t('连接中…'),
  deploying: t('部署中…'),
  ready: t('就绪'),
  error: t('连接失败'),
}

function stateTone(state: TargetState): 'ok' | 'danger' | 'muted' | 'accent' {
  if (state === 'ready') return 'ok'
  if (state === 'error') return 'danger'
  if (state === 'connecting' || state === 'deploying') return 'accent'
  return 'muted'
}

export function TargetsPage() {
  const conn = useApp((s) => s.connections.find((item) => item.id === s.activeId))
  const targets = useApp((s) => s.targets)
  const states = useApp((s) => s.targetStates)
  const errors = useApp((s) => s.targetErrors)
  const connectingId = useApp((s) => s.connectingId)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const eventsError = useApp((s) => s.eventsError)
  const error = useApp((s) => s.error)
  const goBack = useApp((s) => s.goBack)
  const loadTargets = useApp((s) => s.loadTargets)
  const loadAgentSettings = useApp((s) => s.loadAgentSettings)
  const requestConnect = useApp((s) => s.requestConnect)
  const disconnectTarget = useApp((s) => s.disconnectTarget)
  const selectTarget = useApp((s) => s.selectTarget)
  const repair = useApp((s) => s.activeId ? s.needsRepair[s.activeId] : undefined)
  const beginRepair = useApp((s) => s.beginRepair)
  const [menu, setMenu] = useState<string | null>(null)
  const selected = targets.find((target) => target.id === menu)
  const connectingTarget = targets.find((target) => target.id === connectingId)

  useEffect(() => { void loadAgentSettings() }, [loadAgentSettings])

  return (
    <>
      <Header title={t('目标与额度')} subtitle={conn && connectionName(conn.name)} onBack={goBack}
        right={<Button variant="ghost" onClick={() => void Promise.all([loadTargets(), loadAgentSettings()])}
          aria-label={t('刷新目标')}><WorkspaceIcon name="refresh" /></Button>} />
      <div className="qn-body qn-scroll">
        {repair && conn && <Note tone="error" message={t('请重新配对这台电脑。')} actionLabel={t('重新配对')} onAction={() => beginRepair(conn.id)} />}
        {connectingTarget?.kind === 'ssh' && <Note message={t('首次连接或 SSH 指纹变化时，请在电脑上确认指纹。')} />}
        {targets.length === 0 ? (error || repair || eventsError ? <Empty>{t('没有可用的目标。')}</Empty> : <Loading text={t('正在读取目标…')} />) : (
          <div className="qn-list-group">
            {targets.map((target) => {
              const state = states[target.id]?.state ?? 'idle'
              const canOpen = target.kind === 'local' || state === 'ready'
              const busy = state === 'connecting' || state === 'deploying'
              return (
                <div key={target.id} className="qn-list-row qn-row flex-wrap gap-y-1">
                  <button className="qn-row-trigger" type="button" disabled={busy || Boolean(repair)}
                    onClick={() => canOpen ? void selectTarget(target.id) : requestConnect(target.id)}>
                    {/* 本机目标随电脑在线即可用，未单独连接时也不显示成灰色离线。 */}
                    <StatusDot tone={target.kind === 'local' && state === 'idle' && eventsConnected ? 'ok' : stateTone(state)} />
                    <span className="qn-row-copy">
                      <span className="qn-list-primary">{target.name}</span>
                      {target.kind !== 'local' && <span className="qn-subtitle block">
                        {target.kind === 'direct' && t('直连 · ')}{formatAddress(target.host, target.port)}
                      </span>}
                    </span>
                    <Badge tone={stateTone(state)}>{canOpen ? t('查看项目') : busy ? stateText[state] : t('连接')}</Badge>
                  </button>
                  <Button variant="ghost" className="qn-list-action" onClick={() => setMenu(target.id)}
                    aria-label={t('{name} 的目标操作', { name: target.name })}><WorkspaceIcon name="more" /></Button>
                  <TargetRateLimits targetId={target.id} targetName={target.name} available={eventsConnected && !repair && canOpen && !busy} />
                  {errors[target.id] && <p className="w-full break-words text-xs text-qn-danger">{translateMessage(errors[target.id] ?? '')}</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {selected && (
        <Dialog title={selected.name} onClose={() => setMenu(null)}>
          {selected.kind !== 'local' && <p className="mb-2 text-xs text-qn-muted">
            {selected.kind === 'ssh' ? `${selected.username}@` : t('直连 · ')}{formatAddress(selected.host, selected.port)}
          </p>}
          <div className="qn-sheet-actions">
            <SheetAction icon={FolderOpen} onClick={() => { setMenu(null); void selectTarget(selected.id) }}>{t('查看项目')}</SheetAction>
            {states[selected.id]?.state === 'ready' ? (
              <SheetAction icon={Unplug} onClick={() => { setMenu(null); void disconnectTarget(selected.id) }}>{t('断开目标')}</SheetAction>
            ) : (
              <SheetAction icon={PlugZap} onClick={() => { setMenu(null); requestConnect(selected.id) }} disabled={connectingId === selected.id}>{t('连接')}</SheetAction>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}
