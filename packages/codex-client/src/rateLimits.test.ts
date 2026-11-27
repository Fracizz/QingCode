import { describe, expect, it } from 'vitest'
import type { RateLimitSnapshot, RateLimitWindow } from './codex-types'
import {
  applyRateLimitsUpdate,
  claudeHasWindows,
  claudeQuotaBlocked,
  claudeQuotaResetAt,
  claudeQuotaSource,
  claudeQuotaSummary,
  compactText,
  emptySnapshot,
  formatReset,
  mergeSnapshot,
  pickAccount,
  pickClaudeSnapshot,
  pickSnapshot,
  remainingQuotaPercent,
  severity,
  severityForPercent,
  tightestPercent,
  windowLabel,
  windowShortLabel,
} from './rateLimits'

function makeWindow(usedPercent: number, extra: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return { usedPercent, windowDurationMins: null, resetsAt: null, ...extra }
}

function snap(partial: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return { ...emptySnapshot(), ...partial }
}

function response(snapshot: RateLimitSnapshot) {
  return {
    ordinaryUsageAllowed: true,
    rateLimits: snapshot,
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  }
}

describe('pickSnapshot', () => {
  it('优先取 rateLimitsByLimitId.codex', () => {
    const codex = snap({ limitId: 'codex', primary: makeWindow(32) })
    const legacy = snap({ limitId: 'legacy', primary: makeWindow(99) })
    const picked = pickSnapshot({ ...response(legacy), rateLimitsByLimitId: { codex, other: legacy } })
    expect(picked?.limitId).toBe('codex')
    expect(picked?.primary?.usedPercent).toBe(32)
  })

  it('codex 桶缺失或为 null 时回退到单桶视图', () => {
    const fallback = snap({ primary: makeWindow(12, { windowDurationMins: 10080 }) })
    expect(pickSnapshot(response(fallback))?.primary?.usedPercent).toBe(12)
    expect(
      pickSnapshot({ ...response(fallback), rateLimitsByLimitId: { codex: null } })?.primary
        ?.usedPercent,
    ).toBe(12)
  })

  it('接受裸 snapshot 并补全缺省字段', () => {
    expect(pickSnapshot({ primary: { usedPercent: 7 } })).toEqual(
      snap({ primary: makeWindow(7) }),
    )
  })

  it('空输入返回 null', () => {
    expect(pickSnapshot(null)).toBeNull()
    expect(pickSnapshot(undefined)).toBeNull()
    expect(pickSnapshot({})).toBeNull()
    expect(pickSnapshot('bad')).toBeNull()
  })
})

describe('mergeSnapshot', () => {
  const base = snap({
    limitId: 'codex',
    planType: 'plus',
    primary: makeWindow(30, { windowDurationMins: 300, resetsAt: 1_800_000_000 }),
    secondary: makeWindow(10, { windowDurationMins: 10080, resetsAt: 1_800_086_400 }),
    spendControlReached: true,
  })

  it('只覆盖非 null 字段，null 不清除已读到的值', () => {
    const merged = mergeSnapshot(base, {
      limitId: null,
      planType: null,
      primary: { usedPercent: 96, windowDurationMins: null, resetsAt: null },
      rateLimitReachedType: 'rate_limit_reached',
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    })
    expect(merged?.limitId).toBe('codex')
    expect(merged?.planType).toBe('plus')
    expect(merged?.primary).toEqual({
      usedPercent: 96,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    })
    expect(merged?.secondary).toEqual(base.secondary)
    expect(merged?.rateLimitReachedType).toBe('rate_limit_reached')
    expect(merged?.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' })
    expect(base.primary?.usedPercent).toBe(30)
    expect(base.planType).toBe('plus')
  })

  it('false 也是有效值，会覆盖 true', () => {
    expect(mergeSnapshot(base, { spendControlReached: false })?.spendControlReached).toBe(false)
  })

  it('无旧快照时用缺省字段构造，且不修改输入', () => {
    const sparse = { primary: { usedPercent: 50 }, rateLimitReachedType: null }
    expect(mergeSnapshot(null, sparse)).toEqual(snap({ primary: makeWindow(50) }))
    expect(sparse).toEqual({ primary: { usedPercent: 50 }, rateLimitReachedType: null })
    expect(mergeSnapshot(base, null)).toBe(base)
    expect(mergeSnapshot(base, undefined)).toBe(base)
  })

  it('稀疏窗口缺少 usedPercent 时沿用旧窗口', () => {
    expect(mergeSnapshot(base, { primary: { resetsAt: 1_900_000_000 } })?.primary).toEqual({
      usedPercent: 30,
      windowDurationMins: 300,
      resetsAt: 1_900_000_000,
    })
    expect(mergeSnapshot(null, { primary: { windowDurationMins: 300 } })?.primary).toBeNull()
  })

  it('applyRateLimitsUpdate 只处理指定通知', () => {
    const updated = applyRateLimitsUpdate(base, {
      method: 'account/rateLimits/updated',
      params: { rateLimits: { primary: { usedPercent: 81 } } },
    })
    expect(updated?.primary?.usedPercent).toBe(81)
    expect(updated?.primary?.resetsAt).toBe(base.primary?.resetsAt)
    expect(applyRateLimitsUpdate(base, { method: 'turn/completed', params: {} })).toBe(base)
    expect(
      applyRateLimitsUpdate(base, {
        method: 'account/rateLimits/updated',
        rateLimits: { secondary: { usedPercent: 95 } },
      })?.secondary?.usedPercent,
    ).toBe(95)
  })
})

it('Claude 通知与读取使用同一份时间，拒绝事件可以只带重置时间', () => {
  const observedAt = 1_800_000_000_000
  const rejectionResetsAt = 1_800_000_120
  const rateLimits = { observedAt, rejectionResetsAt, rateLimitReachedType: 'rate_limit_reached' }
  const pushed = pickClaudeSnapshot({ method: 'account/rateLimits/updated', params: { rateLimits } })
  expect(pickClaudeSnapshot({ rateLimits })).toEqual(pushed)
  expect(pushed?.observedAt).toBe(observedAt)
  expect(claudeQuotaResetAt(pushed)).toBe(rejectionResetsAt)
  expect(claudeQuotaBlocked(pushed, observedAt)).toBe(true)
  expect(claudeQuotaBlocked(pushed, rejectionResetsAt * 1000)).toBe(false)
  expect(pickClaudeSnapshot({ rateLimits: { primary: makeWindow(0) } })?.observedAt).toBeUndefined()
})

describe('windowLabel / windowShortLabel', () => {
  it('固定窗口名与其他时长', () => {
    expect(windowLabel(300)).toBe('5 小时')
    expect(windowLabel(10080)).toBe('每周')
    expect(windowLabel(1440)).toBe('1 天')
    expect(windowLabel(90)).toBe('1.5 小时')
    expect(windowLabel(45)).toBe('45 分钟')
    expect(windowLabel(null)).toBe('未知窗口')
    expect(windowLabel(0)).toBe('未知窗口')
  })

  it('短名用于徽标', () => {
    expect(windowShortLabel(300)).toBe('5h')
    expect(windowShortLabel(10080)).toBe('周')
    expect(windowShortLabel(2880)).toBe('2d')
    expect(windowShortLabel(90)).toBe('1.5h')
    expect(windowShortLabel(null, '5h')).toBe('5h')
  })
})

describe('severity / tightestPercent / compactText', () => {
  it('80% 与 95% 阈值', () => {
    expect(severityForPercent(79)).toBe('ok')
    expect(severityForPercent(80)).toBe('warn')
    expect(severityForPercent(94)).toBe('warn')
    expect(severityForPercent(95)).toBe('danger')
    expect(severityForPercent(null)).toBe('ok')
  })

  it('按最紧张的窗口与后端限额状态判定', () => {
    expect(severity(snap({ primary: makeWindow(12), secondary: makeWindow(81) }))).toBe('warn')
    expect(severity(snap({ primary: makeWindow(12), secondary: makeWindow(96) }))).toBe('danger')
    expect(severity(snap({ primary: makeWindow(1), rateLimitReachedType: 'rate_limit_reached' }))).toBe(
      'danger',
    )
    expect(severity(snap({ primary: makeWindow(1), spendControlReached: true }))).toBe('danger')
    expect(severity(null)).toBe('ok')
  })

  it('目标列表取最大百分比', () => {
    expect(tightestPercent(snap({ primary: makeWindow(32), secondary: makeWindow(12) }))).toBe(32)
    expect(tightestPercent(snap({ primary: makeWindow(32) }))).toBe(32)
    expect(tightestPercent(snap())).toBeNull()
    expect(tightestPercent(null)).toBeNull()
  })

  it('剩余额度百分比限制在 0 到 100，保留进度条所需精度', () => {
    expect(remainingQuotaPercent(61)).toBe(39)
    expect(remainingQuotaPercent(61.5)).toBe(38.5)
    expect(remainingQuotaPercent(0)).toBe(100)
    expect(remainingQuotaPercent(100)).toBe(0)
    expect(remainingQuotaPercent(-1)).toBe(100)
    expect(remainingQuotaPercent(101)).toBe(0)
  })

  it('徽标文本与无数据回退', () => {
    expect(
      compactText(
        snap({
          primary: makeWindow(32, { windowDurationMins: 300 }),
          secondary: makeWindow(12, { windowDurationMins: 10080 }),
        }),
      ),
    ).toBe('5h 32% · 周 12%')
    expect(compactText(snap({ secondary: makeWindow(7) }))).toBe('周 7%')
    expect(compactText(snap())).toBe('暂无额度数据')
    expect(compactText(null)).toBe('暂无额度数据')
  })

  it('剩余额度徽标展示各窗口的剩余百分比', () => {
    expect(
      compactText(
        snap({ primary: makeWindow(32), secondary: makeWindow(61) }),
        'remaining',
      ),
    ).toBe('剩余 5h 68% · 周 39%')
    expect(compactText(snap({ secondary: makeWindow(100) }), 'remaining')).toBe('剩余 周 0%')
    expect(compactText(snap(), 'remaining')).toBe('暂无额度数据')
    expect(compactText(null, 'remaining')).toBe('暂无额度数据')
  })
})

describe('formatReset', () => {
  const now = new Date(2026, 0, 2, 16, 27, 0).getTime() / 1000
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 0, day, hour, minute, 0).getTime() / 1000

  it('本地时间 + 倒计时', () => {
    expect(formatReset(at(2, 18, 40), now)).toBe('2 小时 13 分后重置（今天 18:40）')
    expect(formatReset(at(2, 18, 40), now * 1000)).toBe('2 小时 13 分后重置（今天 18:40）')
  })

  it('跨日、整小时、天与秒', () => {
    expect(formatReset(at(3, 0, 10), at(2, 23, 50))).toBe('20 分后重置（明天 00:10）')
    expect(formatReset(at(2, 19, 27), now)).toBe('3 小时后重置（今天 19:27）')
    expect(formatReset(at(4, 16, 27), now)).toBe('2 天后重置（1月4日 16:27）')
    expect(formatReset(now + 30, now)).toBe('30 秒后重置（今天 16:27）')
  })

  it('已过重置时间与非法输入', () => {
    expect(formatReset(at(2, 15, 40), now)).toBe('重置时间已过（今天 15:40）')
    expect(formatReset(null, now)).toBe('重置时间未知')
    expect(formatReset(Number.NaN, now)).toBe('重置时间未知')
    expect(formatReset(at(2, 18, 40), Number.NaN)).toBe('重置时间未知')
  })
})

describe('pickAccount', () => {
  it('提取 ChatGPT 账号邮箱与套餐', () => {
    expect(
      pickAccount({
        account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus', workspaceName: null },
        userId: null,
        requiresOpenaiAuth: false,
      }),
    ).toEqual({
      type: 'chatgpt',
      email: 'me@example.com',
      planType: 'plus',
      workspaceName: null,
    })
  })

  it('API Key 登录与缺失账号', () => {
    expect(pickAccount({ account: { type: 'apiKey' } })?.email).toBeNull()
    expect(pickAccount({ account: null })).toBeNull()
    expect(pickAccount(null)).toBeNull()
  })
})

describe('Claude 额度窗口', () => {
  const windows = {
    primary: makeWindow(15, { windowDurationMins: 300 }),
    secondary: makeWindow(58, { windowDurationMins: 10080 }),
  }

  it('SDK unifiedWindows 与状态栏一样按窗口显示剩余额度', () => {
    const sdk = snap({ limitId: 'claude-sdk-windows', ...windows })
    expect(claudeHasWindows(sdk)).toBe(true)
    expect(claudeQuotaSummary(sdk)).toBe(claudeQuotaSummary(snap({ limitId: 'claude-statusline', ...windows })))
    expect(claudeQuotaSummary(sdk)).toContain('85%')
    expect(claudeQuotaSummary(sdk)).toContain('42%')
    expect(claudeQuotaSource(sdk)).toContain('SDK')
  })

  it('旧版单窗口事件和空快照不按窗口显示', () => {
    expect(claudeHasWindows(snap({ limitId: 'claude', primary: makeWindow(90) }))).toBe(false)
    expect(claudeHasWindows(snap({ limitId: 'claude-sdk-windows' }))).toBe(false)
  })
})
