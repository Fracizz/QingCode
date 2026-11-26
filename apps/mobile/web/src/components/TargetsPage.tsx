import { formatAddress } from '../link'
import { useApp } from '../store'
import type { TargetState } from '../types'
import { Badge, Button, Card, Empty, Header, Loading, Note, StatusDot } from './ui'
import { RateLimitBadge } from './RateLimitView'

const stateText: Record<TargetState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  deploying: '部署中…',
  ready: '就绪',
  error: '连接失败',
}

function stateTone(state: TargetState): 'ok' | 'warn' | 'danger' | 'muted' | 'accent' {
  if (state === 'ready') return 'ok'
  if (state === 'error') return 'danger'
  if (state === 'connecting' || state === 'deploying') return 'accent'
  return 'muted'
}

export function TargetsPage() {
  const connections = useApp((s) => s.connections)
  const activeId = useApp((s) => s.activeId)
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
  const openEditForm = useApp((s) => s.openEditForm)
  const loadTargets = useApp((s) => s.loadTargets)
  const requestConnect = useApp((s) => s.requestConnect)
  const disconnectTarget = useApp((s) => s.disconnectTarget)
  const selectTarget = useApp((s) => s.selectTarget)

  const conn = connections.find((item) => item.id === activeId)

  return (
    <>
      <Header
        title={conn?.name ?? '电脑'}
        subtitle={`${conn ? formatAddress(conn.host, conn.port) : ''} · ${eventsConnected ? '事件流已连接' : '事件流未连接'}`}
        onBack={goBack}
        right={
          <div className="flex shrink-0 gap-1">
            {conn && (
              <Button variant="ghost" className="px-2" onClick={() => openEditForm(conn.id)}>
                编辑连接
              </Button>
            )}
            <Button variant="ghost" className="px-2" onClick={() => void loadTargets()} aria-label="刷新">
              ⟳
            </Button>
          </div>
        }
      />
      <div className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {eventsError && <Note message={`事件流：${eventsError}；正在自动重连…`} tone="warn" />}
        {connectingId && (
          <Note message="连接中…首次连接或主机指纹变化时，请在电脑上确认主机指纹。" />
        )}
        {targets.length === 0 &&
          (eventsConnected ? (
            <Loading text="正在读取目标列表…" />
          ) : (
            <Empty>无法读取目标列表，请确认电脑在线并已开启手机网关。</Empty>
          ))}
        <div className="space-y-3">
          {targets.map((target) => {
            const state = states[target.id]?.state ?? 'idle'
            const targetError = errors[target.id]
            return (
              <Card key={target.id}>
                <div className="qn-row">
                  <StatusDot tone={stateTone(state)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{target.name}</div>
                    <div className="qn-subtitle">
                      {target.kind === 'local'
                        ? '本机'
                        : `${target.username}@${target.host}:${target.port} · ${target.auth.kind}`}
                    </div>
                  </div>
                  <Badge tone={stateTone(state)}>{stateText[state]}</Badge>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <RateLimitBadge targetId={target.id} hideWhenEmpty />
                </div>
                {targetError && <div className="mt-2"><Note message={targetError} tone="error" /></div>}
                <div className="mt-2 flex gap-2 border-t border-qn-border pt-2">
                  <Button
                    className="flex-1"
                    disabled={connectingId === target.id || state === 'connecting' || state === 'deploying'}
                    onClick={() => requestConnect(target.id)}
                  >
                    {state === 'ready' ? '重新连接' : '连接'}
                  </Button>
                  <Button className="flex-1" variant="primary" onClick={() => void selectTarget(target.id)}>
                    项目
                  </Button>
                  <Button className="flex-1" onClick={() => void disconnectTarget(target.id)}>
                    断开
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      </div>
    </>
  )
}
