import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// Android WebView 资产的国际化：中文为 key，英文词典需覆盖所有界面文案。
import { EN, initLocale, LOCALE_KEY, resolveLocale, setLocale, t } from '../../mobile/android/web/i18n.js'
import { SHORTCUT_KEYS } from '../../mobile/android/web/keyLayout.js'
import { formatDuration, idleLabel, sessionName } from '../../mobile/android/web/protocol.js'

const root = resolve(import.meta.dirname, '../..')
const web = resolve(root, 'mobile/android/web')
const han = /[一-鿿]/
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

afterEach(() => setLocale('zh'))

describe('Android i18n', () => {
  it('follows the system language unless the user picked one', () => {
    expect(resolveLocale('auto', ['zh-CN'])).toBe('zh')
    expect(resolveLocale('auto', ['zh-Hant-TW'])).toBe('zh')
    expect(resolveLocale('auto', ['en-US'])).toBe('en')
    expect(resolveLocale('auto', ['ja-JP'])).toBe('en')
    expect(resolveLocale('auto', [])).toBe('zh')
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh', ['en-US'])).toBe('zh')
    const storage = new Map<string, string>([[LOCALE_KEY, 'en']])
    const store = { getItem: (key: string) => storage.get(key) ?? null }
    expect(initLocale(store, { languages: ['zh-CN'] })).toBe('en')
    storage.clear()
    expect(initLocale(store, { language: 'zh-CN' })).toBe('zh')
  })

  it('translates with placeholders and falls back to the original text', () => {
    expect(t('{n} 个项目', { n: 3 })).toBe('3 个项目')
    setLocale('en')
    expect(t('{n} 个项目', { n: 3 })).toBe('3 projects')
    expect(t('终端不存在。')).toBe('Terminal not found.')
    expect(t('电脑端的新错误')).toBe('电脑端的新错误')
    expect(t('Already English')).toBe('Already English')
  })

  it('localizes pure protocol helpers', () => {
    setLocale('en')
    expect(formatDuration(90 * 60000)).toBe('1 h 30 min')
    expect(sessionName({ number: 2 })).toBe('Terminal 2')
    expect(sessionName({ number: 3, name: '终端 3' })).toBe('Terminal 3')
    expect(sessionName({ number: 3, name: '终端 3', customName: true })).toBe('终端 3')
    expect(idleLabel({ idleDeadline: 3_600_000, lastActiveAt: 0 }, 0)).toBe('Active just now, auto-ends in 1 h')
  })

  it('keeps the same placeholders in every English entry', () => {
    for (const [key, value] of Object.entries(EN)) expect(placeholders(value), key).toEqual(placeholders(key))
  })

  it('covers every t() key in the Android web modules', () => {
    const missing: string[] = []
    for (const name of readdirSync(web).filter(file => file.endsWith('.js'))) {
      const source = readFileSync(resolve(web, name), 'utf8')
      for (const match of source.matchAll(/\bt\(\s*(?:[^'()]*\?\s*)?'([^']+)'(?:\s*:\s*'([^']+)')?/g)) {
        for (const key of [match[1], match[2]]) if (key && han.test(key) && !(key in EN)) missing.push(`${name}: ${key}`)
      }
    }
    for (const item of SHORTCUT_KEYS) for (const key of [item.name, item.label]) if (han.test(key) && !(key in EN)) missing.push(`keyLayout.js: ${key}`)
    expect(missing).toEqual([])
  })

  it('covers every static Chinese text and attribute in index.html', () => {
    const html = readFileSync(resolve(web, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const missing: string[] = []
    for (const match of html.matchAll(/>([^<>]+)</g)) {
      const key = match[1].trim()
      if (han.test(key) && !(key in EN)) missing.push(key)
    }
    for (const match of html.matchAll(/(?:placeholder|aria-label|alt)="([^"]+)"/g)) {
      if (han.test(match[1]) && !(match[1] in EN)) missing.push(match[1])
    }
    for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) if (!(match[1] in EN)) missing.push(match[1])
    expect(missing).toEqual([])
  })

  it('covers user-facing errors returned by the Android native layer', () => {
    // 带 HTTP 状态码的动态消息不收录。
    const dynamic = new Set(['Windows 返回 HTTP '])
    const missing: string[] = []
    for (const name of ['MainActivity.java', 'NativeRequests.java', 'AppUpdates.java']) {
      const source = readFileSync(resolve(root, 'mobile/android', name), 'utf8')
      for (const match of source.matchAll(/(?:(?:failure|Exception|cancel)\(|notifyUpdate\("\w+", |put\("message", |\?\s*)"([^"]+)"/g)) {
        if (han.test(match[1]) && !(match[1] in EN) && !dynamic.has(match[1])) missing.push(`${name}: ${match[1]}`)
      }
    }
    expect(missing).toEqual([])
  })
})
