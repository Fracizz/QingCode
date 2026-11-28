import { displayAsyncQuestionReply, formatDuration, parseAsyncQuestionReply, t, type ItemView } from '@qn/codex-client'
import { CircleAlert, Clock3, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { echoedSteerIds } from '../pendingSteers'
import { selectedPendingSteers, useApp } from '../store'
import { Button } from './ui'

// 本轮结束到 Claude 接着开下一轮之间会短暂空闲，留一点余量再判定未被接收，避免闪一下警告。
const STALE_AFTER_MS = 2000
// 等待超过这个时长才显示已等待多久，短等待只显示状态。
const ELAPSED_AFTER_MS = 10_000

/**
 * 已发出、Agent 尚未回显的引导消息，以半透明用户气泡排在对话末尾。
 * Claude 只在当前一步（工具调用、一段回复）结束后才读取引导，期间对话里没有任何痕迹；
 * 这里如实说明在等什么、已等多久，回显到达后占位消失，真正的消息出现在同一位置。
 */
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
  const [now, setNow] = useState(() => Date.now())

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
  const waiting = running || !stale
  const hasVisible = visible.length > 0

  // 只在有等待中的引导时走表，用来更新“已等待”与延迟出现的说明。
  useEffect(() => {
    if (!hasVisible || !waiting) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasVisible, waiting])

  if (!hasVisible) return null
  const oldest = Math.min(...visible.map((steer) => steer.sentAt))
  const waited = Math.max(0, now - oldest)

  return (
    <section className="qn-steer-pending" aria-label={t('引导消息')} aria-live="polite">
      <ul className="space-y-3" aria-label={t('等待接收的引导消息')}>
        {visible.map((steer) => (
          <li key={steer.id} className="flex flex-col items-end">
            <div className="qn-user-bubble qn-user-bubble-pending" data-stale={waiting ? undefined : 'true'}>
              <p className="whitespace-pre-wrap break-words">
                {displayAsyncQuestionReply(steer.text).trim() || t('附件或引用')}
                {steer.attachments > 0 && <span className="text-qn-muted"> · {t('{count} 个附件', { count: steer.attachments })}</span>}
              </p>
            </div>
            {!waiting && (
              <div className="qn-steer-actions">
                {steer.text.trim() && !parseAsyncQuestionReply(steer.text) && (
                  <Button variant="ghost" className="qn-steer-action" onClick={() => { onRestore(steer.text); drop([steer.id]) }}>
                    <Undo2 size={14} aria-hidden />{t('放回输入框')}
                  </Button>
                )}
                <Button variant="ghost" className="qn-steer-action" aria-label={t('移除引导消息')} onClick={() => drop([steer.id])}>
                  <X size={14} aria-hidden />{t('移除')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {waiting ? (
        <div className="qn-steer-status" role="status">
          <Clock3 size={13} aria-hidden />
          <span>
            {t('引导已发送，等待 {agent} 读取', { agent: agentName })}
            {waited >= ELAPSED_AFTER_MS && <span className="tabular-nums"> · {t('已等待 {time}', { time: formatDuration(waited) })}</span>}
            {/* 只有 Claude / pi 会留占位（Codex 收到即回显），说明直接显示，不再延迟出现。 */}
            <span className="qn-steer-hint">{t('{agent} 做完当前这一步（一段回复或一次工具调用）后才会读取，不会打断它。', { agent: agentName })}</span>
          </span>
        </div>
      ) : (
        <div className="qn-steer-status" data-tone="warn" role="status">
          <CircleAlert size={13} aria-hidden />
          <span>
            {t('{agent} 未确认接收引导', { agent: agentName })}
            <span className="qn-steer-hint">{t('本轮已结束，这条引导可能没有送达。可放回输入框重新发送。')}</span>
          </span>
        </div>
      )}
    </section>
  )
}
