// Codex 额度重置卡：读取 account/rateLimits/read 的 rateLimitResetCredits，兑换走 account/rateLimitResetCredit/consume。
import { getLocale, t, translateMessage } from '../../protocol/src/i18n'
import type { CodexRpcLike } from './api'

export type ResetCredit = {
  id: string
  title: string | null
  description: string | null
  /** 秒级时间戳；null 表示不过期。 */
  expiresAt: number | null
  redeeming: boolean
}

export type ResetCredits = {
  availableCount: number
  /** 后端可能只给张数，或只列出一部分明细。 */
  credits: ResetCredit[]
}

export type ResetCreditNotice = { tone: 'ok' | 'warn' | 'danger'; text: string }

const CONSUME_TIMEOUT_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 旧版 Codex 或不适用的账号没有该字段，返回 null，界面整块隐藏。 */
export function pickResetCredits(response: unknown): ResetCredits | null {
  const summary = isRecord(response) && isRecord(response.rateLimitResetCredits) ? response.rateLimitResetCredits : null
  if (!summary) return null
  // 协议类型标成 bigint，经 JSON 传输后是 number。
  const availableCount = typeof summary.availableCount === 'number' || typeof summary.availableCount === 'string'
    ? Number(summary.availableCount) : NaN
  if (!Number.isInteger(availableCount) || availableCount < 0) return null
  const credits: ResetCredit[] = []
  for (const row of Array.isArray(summary.credits) ? summary.credits : []) {
    if (!isRecord(row) || !text(row.id) || (row.status !== 'available' && row.status !== 'redeeming')) continue
    credits.push({
      id: row.id as string,
      title: text(row.title),
      description: text(row.description),
      expiresAt: typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) ? row.expiresAt : null,
      redeeming: row.status === 'redeeming',
    })
  }
  // 快过期的排在前面。
  credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
  return { availableCount, credits }
}

/** 有可用张数但明细里没有列出的卡数。 */
export function unlistedResetCredits(summary: ResetCredits): number {
  return Math.max(0, summary.availableCount - summary.credits.filter((credit) => !credit.redeeming).length)
}

export function resetCreditExpiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return t('长期有效')
  if (expiresAt * 1000 <= now) return t('已过期')
  const when = new Date(expiresAt * 1000).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  return t('有效期至 {when}', { when })
}

function outcomeNotice(outcome: unknown): ResetCreditNotice | null {
  switch (outcome) {
    case 'reset': return { tone: 'ok', text: t('已使用重置卡，额度已重置') }
    case 'nothingToReset': return { tone: 'warn', text: t('当前没有需要重置的额度') }
    case 'noCredit': return { tone: 'warn', text: t('没有可用的重置卡') }
    case 'alreadyRedeemed': return { tone: 'ok', text: t('这次重置此前已完成') }
    default: return null
  }
}

/**
 * 生成兑换函数。只应由用户确认后调用（Agent 适配规范：有副作用的账户方法禁止自动调用）。
 * scope 区分不同目标；结果未知的尝试沿用原幂等键，避免重试时多扣一张。
 */
export function createResetCreditRedeemer(createKey: () => string) {
  const attempts = new Map<string, string>()
  return async (rpc: CodexRpcLike, scope: string, creditId: string | null): Promise<ResetCreditNotice> => {
    const attempt = JSON.stringify([scope, creditId])
    const idempotencyKey = attempts.get(attempt) ?? createKey()
    attempts.set(attempt, idempotencyKey)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey, ...(creditId ? { creditId } : {}) }),
        // 连接中断时回包可能永远不到，超时后让用户查看额度再决定是否重试。
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(t('等待结果超时'))), CONSUME_TIMEOUT_MS)
        }),
      ])
      const notice = outcomeNotice(response?.outcome)
      if (!notice) return { tone: 'warn', text: t('无法确认使用结果，请刷新额度后查看') }
      attempts.delete(attempt)
      return notice
    } catch (error) {
      const reason = error instanceof Error ? translateMessage(error.message) : ''
      return { tone: 'danger', text: t('未确认使用结果，请先刷新额度查看。{reason}', { reason }) }
    } finally {
      clearTimeout(timer)
    }
  }
}
