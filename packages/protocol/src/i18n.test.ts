import { afterEach, describe, expect, it } from 'vitest'
import { addEnglishMessages, getLocale, resolveLocale, setLocale, t, translateMessage } from './i18n'

afterEach(() => setLocale('zh'))

describe('t', () => {
  it('默认返回中文原文并替换占位符', () => {
    expect(getLocale()).toBe('zh')
    expect(t('共 {count} 个文件', { count: 3 })).toBe('共 3 个文件')
  })

  it('英文环境查词典，缺译回退原文', () => {
    addEnglishMessages({ '共 {count} 个文件': '{count} file(s)' })
    setLocale('en')
    expect(t('共 {count} 个文件', { count: 0 })).toBe('0 file(s)')
    expect(t('尚未翻译')).toBe('尚未翻译')
  })

  it('未提供的占位符原样保留，不读取原型链', () => {
    expect(t('{name} {toString}', {})).toBe('{name} {toString}')
  })
})

describe('translateMessage', () => {
  it('整句、模板与嵌套提示都能翻译', () => {
    addEnglishMessages({
      '连接已断开': 'Disconnected',
      '无法读取 {path}': 'Cannot read {path}',
      '连接失败：{reason}': 'Connection failed: {reason}',
      '连接失败：{reason}（已重试 {count} 次）': 'Connection failed: {reason} ({count} retries)',
    })
    setLocale('en')
    expect(translateMessage('连接已断开')).toBe('Disconnected')
    expect(translateMessage('无法读取 a/(b).ts')).toBe('Cannot read a/(b).ts')
    expect(translateMessage('连接失败：连接已断开')).toBe('Connection failed: Disconnected')
    expect(translateMessage('连接失败：超时（已重试 2 次）')).toBe('Connection failed: 超时 (2 retries)')
  })

  it('中文环境与未收录内容原样返回', () => {
    expect(translateMessage('连接已断开')).toBe('连接已断开')
    setLocale('en')
    expect(translateMessage('模型回复的内容')).toBe('模型回复的内容')
  })
})

describe('resolveLocale', () => {
  it('手动选择优先于系统语言', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh', ['en-US'])).toBe('zh')
  })

  it('跟随系统时按首选语言判断', () => {
    expect(resolveLocale('system', ['zh-Hant-TW', 'en'])).toBe('zh')
    expect(resolveLocale('system', ['ja-JP', 'zh-CN'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('en')
  })
})
