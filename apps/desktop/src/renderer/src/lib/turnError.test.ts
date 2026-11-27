import { describe, expect, it } from 'vitest'
import { describeTurnError, humanizeDuration, shortUrl, splitLinks } from './turnError'

const OPENCODE_429 =
  '429: {"code":null,"message":"OpenCode Go: OpenCode Go usage limit reached (weekly, resets in 3d 12h). To keep going now, turn on Extra Usage or upgrade to Go Plus at https://opencode.ai/console/org_01M5PJ1539S8H0N5GDW9NJTWGM/go. (out of its allowance: not asked again before Nov 30 07:42 UTC+8)","param":null,"type":"rate_limit_error"}'

describe('describeTurnError', () => {
  it('从 429 JSON 中提取额度用尽说明与重置时间', () => {
    const view = describeTurnError(OPENCODE_429)
    expect(view.status).toBe(429)
    expect(view.title).toBe('模型用量额度已用尽')
    expect(view.detail.startsWith('OpenCode Go: OpenCode Go usage limit reached')).toBe(true)
    expect(view.detail).not.toContain('"param"')
    expect(view.hint).toBe('约 3 天 12 小时后重置')
    expect(view.raw).toBe(OPENCODE_429)
  })

  it('识别普通限流', () => {
    const view = describeTurnError('unexpected status 429 Too Many Requests: {"error":{"message":"Rate limit exceeded, retry after 20s","type":"rate_limit"}}')
    expect(view.status).toBe(429)
    expect(view.title).toBe('请求过于频繁，已被限流')
    expect(view.detail).toBe('Rate limit exceeded, retry after 20s')
    expect(view.hint).toBe('约 20 秒后可重试')
  })

  it('识别认证、上下文与服务端错误', () => {
    expect(describeTurnError('401: {"error":{"message":"Invalid API key"}}').title).toBe('认证失败，请重新登录或检查 API Key')
    expect(describeTurnError('400: {"error":{"message":"maximum context length is 200000 tokens"}}').title).toBe(
      '对话内容超出模型上下文上限',
    )
    expect(describeTurnError('529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').title).toBe(
      '模型服务繁忙，请稍后重试',
    )
    expect(describeTurnError('502 Bad Gateway').title).toBe('模型服务暂时不可用，请稍后重试')
    expect(describeTurnError('fetch failed: ECONNREFUSED').title).toBe('网络连接失败，请检查网络或代理')
  })

  it('无法识别时保留原文', () => {
    const view = describeTurnError('something odd happened')
    expect(view.title).toBe('本轮对话失败')
    expect(view.detail).toBe('something odd happened')
    expect(view.status).toBeUndefined()
  })

  it('JSON 损坏时回退原文', () => {
    const view = describeTurnError('500: {"message": broken')
    expect(view.status).toBe(500)
    expect(view.detail).toBe('500: {"message": broken')
  })
})

describe('splitLinks', () => {
  it('拆出链接并剥掉末尾句号', () => {
    const segments = splitLinks('upgrade at https://opencode.ai/console/go. Thanks')
    expect(segments).toEqual([
      { kind: 'text', text: 'upgrade at ' },
      { kind: 'link', url: 'https://opencode.ai/console/go', label: 'opencode.ai/console/go' },
      { kind: 'text', text: '. Thanks' },
    ])
  })

  it('长链接显示时截断', () => {
    const label = shortUrl('https://opencode.ai/console/org_01M5PJ1539S8H0N5GDW9NJTWGM/go')
    expect(label.length).toBe(38)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('humanizeDuration', () => {
  it('转换常见时长单位', () => {
    expect(humanizeDuration('3d 12h')).toBe('3 天 12 小时')
    expect(humanizeDuration('45m')).toBe('45 分钟')
  })
})
