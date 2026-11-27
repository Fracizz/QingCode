// 中英文国际化核心：以中文原文作键，缺译时回退原文，调用处无需另起键名。
// 本文件保持零依赖，浏览器端（经 @qn/codex-client 转出）与 Node 端共用。

export type Locale = 'zh' | 'en'
export type LocalePreference = 'system' | Locale
export type MessageParams = Readonly<Record<string, string | number>>

interface MessagePattern {
  expression: RegExp
  names: string[]
  translated: string
  weight: number
}

let current: Locale = 'zh'
const english = new Map<string, string>()
// 带占位符词条编译出的匹配器，词典变化后重建。
let patterns: MessagePattern[] | null = null

/** 各端启动时注册自己的英文词典，可分多次调用。 */
export function addEnglishMessages(messages: Readonly<Record<string, string>>): void {
  for (const [source, translated] of Object.entries(messages)) english.set(source, translated)
  patterns = null
}

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/** 跟随系统时只看首选语言：中文（含繁体地区）显示中文，其余一律英文。 */
export function resolveLocale(preference: LocalePreference, systemLanguages: readonly string[]): Locale {
  if (preference !== 'system') return preference
  return /^zh(?:[-_]|$)/i.test(systemLanguages[0] ?? '') ? 'zh' : 'en'
}

/**
 * 取当前语言的文案，`{name}` 用 params 替换。
 * 切换语言靠重载界面，启动时须先设置语言，模块顶层常量里的调用才能取到正确结果。
 */
export function t(source: string, params?: MessageParams): string {
  const text = current === 'en' ? (english.get(source) ?? source) : source
  return params ? fill(text, params) : text
}

/**
 * 翻译另一进程发来的现成中文（daemon、backend、原生层的提示）。
 * 这些进程可能同时服务不同语言的界面，所以保持发中文，由展示端按词典整句或按占位符模板匹配；
 * 匹配不上原样返回，Agent 与系统给出的内容不受影响。
 */
export function translateMessage(message: string): string {
  if (current !== 'en' || !/[一-鿿]/.test(message)) return message
  const exact = english.get(message)
  if (exact !== undefined) return exact
  patterns ??= compilePatterns()
  for (const { expression, names, translated } of patterns) {
    const match = expression.exec(message)
    if (!match) continue
    // 占位内容可能是下层传上来的中文提示，递归翻译；每层都比外层短，必然终止。
    const params = Object.fromEntries(names.map((name, index) => [name, translateMessage(match[index + 1] ?? '')]))
    return fill(translated, params)
  }
  return message
}

function fill(text: string, params: MessageParams): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  )
}

function compilePatterns(): MessagePattern[] {
  const compiled: MessagePattern[] = []
  for (const [source, translated] of english) {
    // split 带捕获组：偶数位是固定文字，奇数位是占位符名。
    const parts = source.split(/\{(\w+)\}/)
    if (parts.length === 1) continue
    const literals = parts.filter((_, index) => index % 2 === 0)
    // 固定部分不含中文的模板过于宽泛（如 `{a}：{b}`），不参与匹配。
    if (!/[一-鿿]/.test(literals.join(''))) continue
    const body = literals.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)')
    compiled.push({
      expression: new RegExp(`^${body}$`),
      names: parts.filter((_, index) => index % 2 === 1),
      translated,
      weight: literals.join('').length,
    })
  }
  // 固定文字越长越具体，优先匹配。
  return compiled.sort((a, b) => b.weight - a.weight)
}
