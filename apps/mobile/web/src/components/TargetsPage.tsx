import { useState } from 'react'
import { formatAddress } from '../link'
import { useApp } from '../store'
import type { TargetState } from '../types'
import { Badge, Button, Dialog, Empty, Header, Loading, Note, StatusDot } from './ui'
import { RateLimitBadge } from './RateLimitView'
import { WorkspaceIcon } from './WorkspaceHome'

const stateText: Record<TargetState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  deploying: '部署中…',
  ready: '就绪',
  error: '连接失败',
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
  const notice = useApp((s) => s.notice)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const goBack = useApp((s) => s.goBack)
  const loadTargets = useApp((s) => s.loadTargets)
  const requestConnect = useApp((s) => s.requestConnect)
  const disconnectTarget = useApp((s) => s.disconnectTarget)
  const selectTarget = useApp((s) => s.selectTarget)
  const repair = useApp((s) => s.activeId ? s.needsRepair[s.activeId] : undefined)
  const beginRepair = useApp((s) => s.beginRepair)
  const [menu, setMenu] = useState<string | null>(null)
  const selected = targets.find((target) => target.id === menu)

  return (
    <>
      <Header title="目标" subtitle={conn?.name} onBack={goBack}
        right={<Button variant="ghost" onClick={() => void loadTargets()} aria-label="刷新目标"><WorkspaceIcon name="refresh" /></Button>} />
      <div className="qn-body qn-scroll">
        {repair && conn && <Note tone="error" message="请重新配对这台电脑。" actionLabel="重新配对" onAction={() => beginRepair(conn.id)} />}
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {eventsError && !repair && <Note message={eventsError} tone="warn" />}
        {connectingId && <Note message="首次连接或 SSH 指纹变化时，请在电脑上确认指纹。" />}
        {targets.length === 0 ? (error || repair ? <Empty>没有可用的目标。</Empty> : <Loading text="正在读取目标…" />) : (
          <div className="qn-list-group">
            {targets.map((target) => {
              const state = states[target.id]?.state ?? 'idle'
              const canOpen = target.kind === 'local' || state === 'ready'
              const busy = state === 'connecting' || state === 'deploying'
              return (
                <div key={target.id} className="qn-list-row qn-row flex-wrap gap-y-1">
                  <button className="qn-row-trigger" type="button" disabled={busy || Boolean(repair)}
                    onClick={() => canOpen ? void selectTarget(target.id) : requestConnect(target.id)}>
                    <StatusDot tone={stateTone(state)} />
                    <span className="qn-row-copy">
                      <span className="qn-list-primary">{target.name}</span>
                      {target.kind === 'ssh' && <span className="qn-subtitle block">{formatAddress(target.host, target.port)}</span>}
                    </span>
                    <RateLimitBadge targetId={target.id} hideWhenEmpty />
                    <Badge tone={stateTone(state)}>{canOpen ? '查看项目' : busy ? stateText[state] : '连接'}</Badge>
                  </button>
                  <Button variant="ghost" className="qn-list-action" onClick={() => setMenu(target.id)}
                    aria-label={`${target.name} 的目标操作`}><WorkspaceIcon name="more" /></Button>
                  {errors[target.id] && <p className="w-full break-words text-xs text-qn-danger">{errors[target.id]}</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {selected && (
        <Dialog title={selected.name} onClose={() => setMenu(null)}>
          {selected.kind === 'ssh' && <p className="mb-2 text-xs text-qn-muted">{selected.username}@{formatAddress(selected.host, selected.port)}</p>}
          <div className="grid gap-2">
            <Button onClick={() => { setMenu(null); void selectTarget(selected.id) }}>查看项目</Button>
            {states[selected.id]?.state === 'ready' ? (
              <Button onClick={() => { setMenu(null); void disconnectTarget(selected.id) }}>断开目标</Button>
            ) : (
              <Button onClick={() => { setMenu(null); requestConnect(selected.id) }} disabled={connectingId === selected.id}>连接</Button>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}
