import { create } from 'zustand'
import englishLocaleJson from '../locales/en.json'
import chineseLocaleJson from '../locales/zh-CN.json'
import { isTauri, safeInvoke } from './tauri'
import {
  mergeLocalePackage,
  type LocalePackage,
} from './userLocales'

/** Language id: built-in `zh-CN` / `en`, or a user pack locale code. */
export type AppLanguage = string

export type LocaleOption = { locale: string; label: string; builtin: boolean }

type Values = Record<string, string | number>

const LANGUAGE_KEY = 'qingcode:language'
const DEFAULT_LANGUAGE: AppLanguage = 'zh-CN'

const builtinPackages: Record<string, LocalePackage> = {
  'zh-CN': { ...(chineseLocaleJson as LocalePackage), builtin: true },
  en: { ...(englishLocaleJson as LocalePackage), builtin: true },
}

let localePackages: Record<string, LocalePackage> = { ...builtinPackages }

function optionsFromPackages(packages: Record<string, LocalePackage>): LocaleOption[] {
  return Object.values(packages)
    .map(({ locale, label, builtin }) => ({
      locale,
      label,
      builtin: builtin === true,
    }))
    .sort((a, b) => {
      // Built-ins first (zh-CN, en), then user locales by code.
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
      if (a.locale === 'zh-CN') return -1
      if (b.locale === 'zh-CN') return 1
      if (a.locale === 'en') return -1
      if (b.locale === 'en') return 1
      return a.locale.localeCompare(b.locale)
    })
}

/** Snapshot of currently registered locales (built-in + user). Prefer useI18n().localeOptions in UI. */
export function getLocaleOptions(): LocaleOption[] {
  return optionsFromPackages(localePackages)
}

function format(text: string, values?: Values) {
  if (!values) return text
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}

function readStoredLanguage(): string | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY)
    if (stored && stored.trim()) return stored.trim()
  } catch {
    /* ignore */
  }
  return null
}

function readLanguage(): AppLanguage {
  const stored = readStoredLanguage()
  if (stored && localePackages[stored]) return stored
  if (stored === 'zh-CN' || stored === 'en') return stored
  return DEFAULT_LANGUAGE
}

function applyLanguage(language: AppLanguage) {
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

type UserLocaleDto = {
  locale: string
  label: string
  messages: Record<string, string>
  path: string
}

type LocaleState = {
  language: AppLanguage
  localeOptions: LocaleOption[]
  setLanguage: (language: AppLanguage) => void
  /** Reload JSON packs from the user locales directory. */
  reloadUserLocales: () => Promise<{ loaded: number; dir: string | null }>
}

function replacePackages(next: Record<string, LocalePackage>) {
  localePackages = next
}

export const useLocaleStore = create<LocaleState>((set, get) => ({
  language: readLanguage(),
  localeOptions: getLocaleOptions(),
  setLanguage: language => {
    if (!localePackages[language]) return
    try {
      localStorage.setItem(LANGUAGE_KEY, language)
    } catch {
      /* ignore */
    }
    applyLanguage(language)
    set({ language })
  },
  reloadUserLocales: async () => {
    if (!isTauri()) {
      replacePackages({ ...builtinPackages })
      const options = getLocaleOptions()
      const language = localePackages[get().language] ? get().language : DEFAULT_LANGUAGE
      set({ localeOptions: options, language })
      applyLanguage(language)
      return { loaded: 0, dir: null }
    }

    const dir = await safeInvoke<string>('读取语言包目录', 'user_locales_dir')
    const packs = await safeInvoke<UserLocaleDto[]>('列出用户语言包', 'list_user_locales')
    let next = { ...builtinPackages }
    for (const pack of packs) {
      next = mergeLocalePackage(next, {
        locale: pack.locale,
        label: pack.label,
        messages: pack.messages,
        path: pack.path,
        builtin: false,
      })
    }
    replacePackages(next)
    const options = getLocaleOptions()
    let language = get().language
    const stored = readStoredLanguage()
    if (stored && next[stored]) language = stored
    else if (!next[language]) language = DEFAULT_LANGUAGE
    try {
      localStorage.setItem(LANGUAGE_KEY, language)
    } catch {
      /* ignore */
    }
    applyLanguage(language)
    set({ localeOptions: options, language })
    return { loaded: packs.length, dir }
  },
}))

export async function initializeLanguage() {
  applyLanguage(useLocaleStore.getState().language)
  try {
    await useLocaleStore.getState().reloadUserLocales()
  } catch (error) {
    console.warn('[i18n] failed to load user locales', error)
  }
}

export function translateFor(language: AppLanguage, source: string, values?: Values) {
  const pack = localePackages[language]
  const text = pack?.messages[source] ?? source
  return format(text, values)
}

/** Translate UI text in React components and rerender when the language changes. */
export function useI18n() {
  const language = useLocaleStore(state => state.language)
  const setLanguage = useLocaleStore(state => state.setLanguage)
  const localeOptions = useLocaleStore(state => state.localeOptions)
  const reloadUserLocales = useLocaleStore(state => state.reloadUserLocales)
  return {
    language,
    setLanguage,
    localeOptions,
    reloadUserLocales,
    t: (source: string, values?: Values) => translateFor(language, source, values),
  }
}

/** Translate interaction feedback emitted outside React render functions. */
export function translate(source: string, values?: Values) {
  return translateFor(useLocaleStore.getState().language, source, values)
}
