import { create } from 'zustand'
import englishLocaleJson from '../locales/en.json'
import chineseLocaleJson from '../locales/zh-CN.json'

export type AppLanguage = 'zh-CN' | 'en'

type Values = Record<string, string | number>

const LANGUAGE_KEY = 'qingcode:language'
const DEFAULT_LANGUAGE: AppLanguage = 'zh-CN'


type LocalePackage = {
  locale: AppLanguage
  label: string
  messages: Record<string, string>
}

const localePackages: Record<AppLanguage, LocalePackage> = {
  'zh-CN': chineseLocaleJson as LocalePackage,
  en: englishLocaleJson as LocalePackage,
}

/** Available language packages. Add a JSON package here to register another language. */
export const localeOptions = Object.values(localePackages).map(({ locale, label }) => ({ locale, label }))

function format(text: string, values?: Values) {
  if (!values) return text
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}

function readLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY)
    if (stored === 'zh-CN' || stored === 'en') return stored
  } catch {}
  return DEFAULT_LANGUAGE
}

function applyLanguage(language: AppLanguage) {
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

type LocaleState = {
  language: AppLanguage
  setLanguage: (language: AppLanguage) => void
}

export const useLocaleStore = create<LocaleState>(set => ({
  language: readLanguage(),
  setLanguage: language => {
    try {
      localStorage.setItem(LANGUAGE_KEY, language)
    } catch {}
    applyLanguage(language)
    set({ language })
  },
}))

export function initializeLanguage() {
  applyLanguage(useLocaleStore.getState().language)
}

export function translateFor(language: AppLanguage, source: string, values?: Values) {
  return format(localePackages[language].messages[source] ?? source, values)
}

/** Translate UI text in React components and rerender when the language changes. */
export function useI18n() {
  const language = useLocaleStore(state => state.language)
  const setLanguage = useLocaleStore(state => state.setLanguage)
  return {
    language,
    setLanguage,
    t: (source: string, values?: Values) => translateFor(language, source, values),
  }
}

/** Translate interaction feedback emitted outside React render functions. */
export function translate(source: string, values?: Values) {
  return translateFor(useLocaleStore.getState().language, source, values)
}
