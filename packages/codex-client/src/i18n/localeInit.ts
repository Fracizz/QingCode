// 界面端启动时的语言装载：偏好存本地，首帧前同步读取。
import { addEnglishMessages, resolveLocale, setLocale, type Locale, type LocalePreference } from '../../../protocol/src/i18n'
import android from './android.en'
import node from './node.en'
import shared from './shared.en'

export const LOCALE_STORAGE_KEY = 'qn.locale'

export function readLocalePreference(): LocalePreference {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)
    return stored === 'zh' || stored === 'en' ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function saveLocalePreference(preference: LocalePreference): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, preference)
  } catch {
    // 存储不可用时仍沿用系统语言。
  }
}

/** 注册公共词典与端内词典，并按偏好设置语言。须早于任何界面模块执行。 */
export function initLocale(appMessages: ReadonlyArray<Readonly<Record<string, string>>>): Locale {
  for (const messages of [shared, node, android, ...appMessages]) addEnglishMessages(messages)
  const locale = resolveLocale(readLocalePreference(), globalThis.navigator?.languages ?? [])
  setLocale(locale)
  // 本包不引入 DOM 类型库，按需取 document。
  const { document } = globalThis as { document?: { documentElement: { lang: string } } }
  if (document) document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  return locale
}
