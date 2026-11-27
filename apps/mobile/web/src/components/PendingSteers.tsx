import { t, type ItemView } from '@qn/codex-client'
import { CornerDownRight, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { echoedSteerIds } from '../pendingSteers'
import { selectedPendingSteers, useApp } from '../store'
import { Badge, Button, LoadingIcon } from './ui'

// 本轮结束到 Claude 接着开下一轮之间会短暂空闲，留一点余量再判定未被接收，避免闪一下警告。
const STALE_AFTER_MS = 2000

/** 已发出、Agent 尚未回显的引导消息。回显到达后自动消失，回显出现在对话里。 */
export function PendingSteers({ items, running, agentName, onRestore }: {
  items: readonly ItemView[]
  running: boolean
  agentName: string
  onRestore: (text: string) => void
}) {
  const pending = useApp(selectedPendingSteers)
  const drop = useApp((state) => state.dropPendingSteers)
  const echoed = useMemo(() => echoedSteerIds(pending ?? [], items), [pending, items])
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (echoed.length > 0) drop(echoed)
  }, [echoed, drop])

  useEffect(() => {
    if (running) {
      setStale(false)
      return
    }
    const timer = window.setTimeout(() => setStale(true), STALE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [running])

  const visible = (pending ?? []).filter((steer) => !echoed.includes(steer.id))
  if (visible.length === 0) return null
  const waiting = running || !stale

  return (
    <section className="qn-queue" aria-label={t('引导消息')} aria-live="polite">
      <div className="flex min-h-9 items-center gap-1.5 pr-2 text-[12.5px]">
        <CornerDownRight size={15} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {waiting
            ? t('引导已发送，等待 {agent} 接收', { agent: agentName })
            : t('{agent} 未确认接收引导', { agent: agentName })}
        </span>
        {waiting ? <LoadingIcon size={13} /> : <Badge tone="warn">{t('未接收')}</Badge>}
      </div>
      {!waiting && (
        <p className="mb-1 pr-2 text-xs text-qn-muted">{t('本轮已结束，这条引导可能没有送达。可放回输入框重新发送。')}</p>
      )}
      <ul className="qn-scroll qn-queue-list" aria-label={t('等待接收的引导消息')}>
        {visible.map((steer) => (
          <li key={steer.id} className="qn-queue-item">
            <p className="min-w-0 flex-1 truncate">
              {steer.text.trim() || t('附件或引用')}
              {steer.attachments > 0 && <span className="text-qn-muted"> · {t('{count} 个附件', { count: steer.attachments })}</span>}
            </p>
            {!waiting && (
              <div className="flex shrink-0 items-center gap-0.5">
                {steer.text.trim() && (
                  <Button variant="ghost" className="qn-icon-button" aria-label={t('放回输入框')}
                    onClick={() => { onRestore(steer.text); drop([steer.id]) }}>
                    <Undo2 size={16} aria-hidden />
                  </Button>
                )}
                <Button variant="ghost" className="qn-icon-button" aria-label={t('移除引导消息')} onClick={() => drop([steer.id])}>
                  <X size={16} aria-hidden />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
