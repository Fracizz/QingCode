import { getLocale, t, translateMessage } from '@qn/codex-client'

/**
 * 把 Agent / 模型服务返回的原始失败串（常见形如 `429: {"message":...}`）整理成可读提示。
 * 各家服务格式不一，解析失败时一律回退为原文，不丢信息。
 */
export interface TurnErrorView {
  /** 一句话结论，用户最先看到的内容 */
  title: string
  /** 服务端给出的可读说明（已从 JSON 中提取），可能为空 */
  detail: string
  /** 可执行的建议，例如何时重置 */
  hint?: string
  /** HTTP 状态码，未识别时为空 */
  status?: number
  /** 原始错误串，用于复制与排查；整句是目标服务提示时随界面语言翻译 */
  raw: string
}

const URL_RE = /https?:\/\/[^\s"'<>()]+/g

/** URL 末尾常粘着句号、逗号等标点，需剥掉才能正确打开 */
export function trimUrl(url: string): string {
  return url.replace(/[.,;:!?，。；：！？]+$/, '')
}

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; url: string; label: string }

/** 显示用：只留域名 + 截断路径，避免超长链接撑满提示框 */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    const label = parsed.host + path
    return label.length > 40 ? `${label.slice(0, 37)}…` : label
  } catch {
    return url
  }
}

export function splitLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const url = trimUrl(match[0])
    const start = match.index ?? 0
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) })
    segments.push({ kind: 'link', url, label: shortUrl(url) })
    last = start + url.length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** 取出第一个能解析的 JSON 对象（错误串里 JSON 前常带状态码或前缀文字） */
function extractJson(raw: string): { json: JsonRecord; prefix: string } | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const json = asRecord(JSON.parse(raw.slice(start, end + 1)))
    return json ? { json, prefix: raw.slice(0, start) } : undefined
  } catch {
    return undefined
  }
}

function pickMessage(json: JsonRecord): { message?: string; type?: string; code?: string } {
  const nested = asRecord(json.error)
  return {
    message:
      asString(nested?.message) ?? asString(json.message) ?? asString(json.error) ?? asString(json.detail),
    type: asString(nested?.type) ?? asString(json.type),
    code: asString(nested?.code) ?? asString(json.code),
  }
}

function pickStatus(text: string): number | undefined {
  const match = /(?:^|\b(?:status|code|http)\s*[:=]?\s*|^\s*)([45]\d\d)\b/i.exec(text)
  return match ? Number(match[1]) : undefined
}

const UNIT: Record<string, string> = { d: '天', h: '小时', m: '分钟', s: '秒' } // i18n-ignore: 中文时长单位，英文沿用原缩写

/** 中文：`3d 12h` → `3 天 12 小时`；英文保留紧凑缩写。 */
export function humanizeDuration(text: string): string {
  const parts = [...text.matchAll(/(\d+)\s*([dhms])\b/gi)].map(
    (m) => {
      const unit = (m[2] ?? '').toLowerCase()
      return getLocale() === 'en' ? `${m[1]}${unit}` : `${m[1]} ${UNIT[unit] ?? m[2]}`
    },
  )
  return parts.length ? parts.join(' ') : text.trim()
}

function resetHint(message: string): string | undefined {
  const relative = /resets?\s+in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(message)
  if (relative?.[1]) return t('约 {duration}后重置', { duration: humanizeDuration(relative[1]) })
  const retry = /(?:retry|try again)\s+(?:after|in)\s+((?:\d+\s*[dhms]\s*)+|\d+\s*seconds?)/i.exec(message)
  if (retry?.[1]) return t('约 {duration}后可重试', { duration: humanizeDuration(retry[1].replace(/\s*seconds?/i, 's')) })
  return undefined
}

function classify(status: number | undefined, type: string, code: string, text: string): string {
  const all = `${type} ${code} ${text}`.toLowerCase()
  if (/usage limit|quota|insufficient_quota|allowance|billing|credit/.test(all)) return t('模型用量额度已用尽')
  if (status === 429 || /rate.?limit|too many requests/.test(all)) return t('请求过于频繁，已被限流')
  if (status === 401 || /unauthori[sz]ed|invalid.?api.?key|authentication/.test(all)) {
    return t('认证失败，请重新登录或检查 API Key')
  }
  if (status === 403 || /forbidden|permission/.test(all)) return t('无权访问该模型或接口')
  if (/context.?length|context window|too many tokens|maximum context/.test(all)) return t('对话内容超出模型上下文上限')
  if (status === 404 || /model.*not.?found|not_found/.test(all)) return t('模型或接口不存在')
  if (status === 529 || /overloaded/.test(all)) return t('模型服务繁忙，请稍后重试')
  if (status !== undefined && status >= 500) return t('模型服务暂时不可用，请稍后重试')
  if (/econnrefused|etimedout|enotfound|econnreset|fetch failed|network|socket hang up/.test(all)) {
    return t('网络连接失败，请检查网络或代理')
  }
  if (status === 400) return t('请求被模型服务拒绝')
  return t('本轮对话失败')
}

export function describeTurnError(input: string): TurnErrorView {
  const raw = input.trim()
  const parsed = extractJson(raw)
  const picked = parsed ? pickMessage(parsed.json) : {}
  const status = pickStatus(parsed ? parsed.prefix : raw) ?? (picked.code ? pickStatus(picked.code) : undefined)
  const detail = picked.message ?? raw
  const title = classify(status, picked.type ?? '', picked.code ?? '', detail)
  // 分类与提示基于原始文本，展示时才翻译目标服务发来的中文。
  const shown = translateMessage(detail)
  const view: TurnErrorView = { title, detail: shown === title ? '' : shown, raw: translateMessage(raw) }
  if (status !== undefined) view.status = status
  const hint = resetHint(detail)
  if (hint) view.hint = hint
  return view
}
