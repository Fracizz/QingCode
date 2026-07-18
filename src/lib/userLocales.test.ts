import { describe, expect, it } from 'vitest'
import {
  isValidLocaleCode,
  mergeLocalePackage,
  parseLocalePackage,
  type LocalePackage,
} from './userLocales'

describe('userLocales', () => {
  it('validates locale codes', () => {
    expect(isValidLocaleCode('en')).toBe(true)
    expect(isValidLocaleCode('zh-CN')).toBe(true)
    expect(isValidLocaleCode('zh_CN')).toBe(false)
    expect(isValidLocaleCode('')).toBe(false)
  })

  it('parses locale packages', () => {
    expect(
      parseLocalePackage({
        locale: 'ja',
        label: '日本語',
        messages: { 设置: '設定', skip: 1 },
      }),
    ).toEqual({
      locale: 'ja',
      label: '日本語',
      messages: { 设置: '設定' },
      path: undefined,
    })
    expect(parseLocalePackage({ locale: 'bad_code', messages: {} })).toBeNull()
  })

  it('merges user packs over builtins', () => {
    const builtin: LocalePackage = {
      locale: 'en',
      label: 'English',
      messages: { 设置: 'Settings', 语言: 'Language' },
      builtin: true,
    }
    const merged = mergeLocalePackage(
      { en: builtin },
      {
        locale: 'en',
        label: 'English (custom)',
        messages: { 设置: 'Prefs' },
        path: 'C:/locales/en.json',
      },
    )
    expect(merged.en.label).toBe('English (custom)')
    expect(merged.en.messages).toEqual({ 设置: 'Prefs', 语言: 'Language' })
    expect(merged.en.builtin).toBe(true)
  })
})
