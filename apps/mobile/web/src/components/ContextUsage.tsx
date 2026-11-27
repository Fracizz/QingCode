import { contextUsage, estimatedTurnUsage, formatTokens } from '@qn/codex-client'
import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { Button, Dialog, LoadingIcon } from './ui'

export function ContextUsage({ tokenUsage, estimatedCostUsd, compact, panel: controlledPanel, onPanelChange }: {
  tokenUsage: unknown
  estimatedCostUsd?: number
  compact?: { busy: boolean; blockedReason: string | null; onConfirm: () => void }
  panel?: 'usage' | 'confirm' | null
  onPanelChange?: (panel: 'usage' | 'confirm' | null) => void
}) {
  const [ownPanel, setOwnPanel] = useState<'usage' | 'confirm' | null>(null)
  const panel = controlledPanel === undefined ? ownPanel : controlledPanel
  const setPanel = onPanelChange ?? setOwnPanel
  const usage = contextUsage(tokenUsage)
  const turn = estimatedTurnUsage(tokenUsage)
  if (!usage && !turn && !compact && estimatedCostUsd == null && !panel) return null

  const percent = usage?.percent ?? 0
  const label = usage ? `上下文已用 ${percent}%` : '暂无上下文用量'
  const sessionUsage = turn !== null || estimatedCostUsd != null
  const color = percent >= 90 ? 'text-qn-danger' : percent >= 75 ? 'text-qn-warn' : 'text-qn-muted'
  const confirming = panel === 'confirm'
  const busy = compact?.busy === true
  return (
    <>
      <Button variant="ghost" className="qn-icon-button px-1!"
        aria-label={busy ? '正在压缩会话' : sessionUsage ? '查看会话用量' : `查看上下文，${label}`}
        aria-haspopup="dialog" onClick={() => setPanel('usage')}>
        <span className={`flex items-center gap-1 text-[11px] ${color}`} aria-hidden>
          {busy ? <LoadingIcon size={16} /> : <Gauge size={16} />}
          {usage && `${percent}%`}
        </span>
      </Button>
      {panel && (
        <Dialog title={confirming ? '确认压缩会话' : sessionUsage ? '会话用量' : '上下文用量'} onClose={() => setPanel(null)}>
          {confirming && compact ? (
            <>
              <p className="text-sm leading-6 text-qn-muted">压缩会总结较早的对话，让后续回复使用更短的上下文。账号已用额度不会恢复。</p>
              {compact.blockedReason && <p className="mt-2 text-sm text-qn-warn">{compact.blockedReason}</p>}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button onClick={() => setPanel('usage')}>取消</Button>
                <Button variant="primary" disabled={busy || !!compact.blockedReason} onClick={() => {
                  setPanel(null)
                  compact.onConfirm()
                }}>确认压缩</Button>
              </div>
            </>
          ) : (
            <>
              {(usage || compact || !sessionUsage) && <p className={`mb-2 text-sm ${color}`}>{label}</p>}
              {usage && (
                <>
                  <progress className="mb-2 w-full accent-current" aria-label="上下文占用" max={100} value={percent} />
                  <p className="text-sm text-qn-muted">{formatTokens(usage.used)} / {formatTokens(usage.window)} tokens</p>
                </>
              )}
              {turn && (
                <div className="space-y-1 text-sm">
                  <p>最近上报的单轮用量</p>
                  {turn.tokens !== null && <p className="text-qn-muted">{formatTokens(turn.tokens)} tokens</p>}
                  {turn.costUsd !== null && <p className="text-qn-muted">费用估算 {formatCost(turn.costUsd)}</p>}
                </div>
              )}
              {estimatedCostUsd != null && (
                <p className="mt-2 text-sm text-qn-muted">
                  本设备已收到的会话费用估算 {formatCost(estimatedCostUsd)}
                </p>
              )}
              {compact && (
                <div className="mt-4 grid gap-2">
                  <Button disabled={busy || !!compact.blockedReason} onClick={() => setPanel('confirm')}>
                    {busy ? '正在压缩会话…' : '压缩会话'}
                  </Button>
                  {!busy && compact.blockedReason && <p className="text-xs text-qn-muted">{compact.blockedReason}</p>}
                </div>
              )}
            </>
          )}
        </Dialog>
      )}
    </>
  )
}

function formatCost(usd: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(usd)
}
