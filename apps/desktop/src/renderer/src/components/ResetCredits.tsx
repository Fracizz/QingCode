import { useState } from 'react'
import { resetCreditExpiry, t, unlistedResetCredits, type ResetCredit } from '@qn/codex-client'
import type { RateLimitEntry } from '../lib/rateLimitsEntry'
import { useRateLimits } from '../store/rateLimits'
import { Modal } from './ui'

const noticeClass = { ok: 'text-qn-ok', warn: 'text-qn-warn', danger: 'text-qn-danger' }

/** Codex 额度重置卡：查看与使用。使用必须经确认框，不做任何自动兑换。 */
export function ResetCredits({ targetId, entry, opened, now }: {
  targetId: string
  entry: RateLimitEntry | undefined
  opened: boolean
  now: number
}) {
  const consume = useRateLimits((s) => s.consumeResetCredit)
  // credit 为 null 表示后端没给明细，由 Codex 选卡。
  const [confirm, setConfirm] = useState<{ targetId: string; credit: ResetCredit | null } | null>(null)
  const summary = entry?.resetCredits
  const notice = entry?.resetNotice
  const busy = entry?.resetting === true
  if (!summary && !notice) return null
  const unlisted = summary ? unlistedResetCredits(summary) : 0
  const pending = confirm?.targetId === targetId ? confirm : null

  const useButton = (credit: ResetCredit | null, label: string) => (
    <button
      type="button"
      className="qn-button-subtle shrink-0 px-2 py-1 text-ui-sm disabled:opacity-40"
      disabled={!opened || busy || credit?.redeeming === true}
      onClick={() => setConfirm({ targetId, credit })}
    >
      {busy || credit?.redeeming ? t('使用中…') : label}
    </button>
  )

  return (
    <section className="mt-2 rounded-lg border border-qn-border/70 p-2" aria-label={t('重置卡')}>
      <div className="flex items-center justify-between">
        <span>{t('重置卡')}</span>
        {summary && <span className="text-qn-muted">{t('可用 {count} 张', { count: summary.availableCount })}</span>}
      </div>
      {summary?.credits.map((credit) => (
        <div key={credit.id} className="mt-1.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate">{credit.title ?? t('额度重置卡')}</div>
            {credit.description && <div className="break-words text-ui-sm text-qn-muted">{credit.description}</div>}
            <div className="text-ui-sm text-qn-muted">{resetCreditExpiry(credit.expiresAt, now)}</div>
          </div>
          {useButton(credit, t('使用'))}
        </div>
      ))}
      {summary && unlisted > 0 && (summary.credits.length === 0
        ? <div className="mt-1.5 flex justify-end">{useButton(null, t('使用一张'))}</div>
        : <div className="mt-1.5 text-ui-sm text-qn-muted">{t('另有 {count} 张未列出明细', { count: unlisted })}</div>)}
      {notice && <div role="status" className={`mt-1.5 text-ui-sm ${noticeClass[notice.tone]}`}>{notice.text}</div>}
      {pending && (
        <Modal
          title={t('使用重置卡？')}
          width="max-w-sm"
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex justify-end gap-2">
              {/* 默认焦点放在「取消」，避免误按回车直接消耗卡。 */}
              <button type="button" className="qn-button-subtle" autoFocus onClick={() => setConfirm(null)}>{t('取消')}</button>
              <button
                type="button"
                className="qn-button disabled:opacity-40"
                disabled={!opened || busy}
                onClick={() => {
                  setConfirm(null)
                  void consume(targetId, pending.credit?.id ?? null)
                }}
              >
                {t('确认使用')}
              </button>
            </div>
          }
        >
          <p>{t('将消耗 1 张重置卡来重置当前账号的 Codex 额度，使用后无法撤销。')}</p>
          <div className="mt-2 text-qn-muted">
            {pending.credit
              ? <>
                <div>{pending.credit.title ?? t('额度重置卡')}</div>
                <div>{resetCreditExpiry(pending.credit.expiresAt, now)}</div>
              </>
              : <div>{t('由 Codex 选择下一张可用的卡。')}</div>}
            {entry?.account?.email && <div className="break-all">{t('账号：{email}', { email: entry.account.email })}</div>}
          </div>
        </Modal>
      )}
    </section>
  )
}
