import { RUNNING_SEND_PREFERENCES, type RunningSendPreference } from '@qn/codex-client'
import { useLayoutEffect, useState } from 'react'
import { create } from 'zustand'
import { callDevice } from './client'
import { getWindowNativePort } from './native'

/** 与电脑版主题一致：深色（默认）、灰色、浅色。 */
export type MobileTheme = 'dark' | 'gray' | 'light'
/** 图片压缩档位：高压缩体积最小，低压缩画质最好。 */
export type ImageCompression = 'high' | 'medium' | 'low'
export const IMAGE_COMPRESSIONS: readonly ImageCompression[] = ['high', 'medium', 'low']
export const SESSION_PREVIEW_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
type SessionPreviewCount = (typeof SESSION_PREVIEW_COUNTS)[number]
type MobilePreferences = {
  theme: MobileTheme
  followSystemDark: boolean
  reduceMotion: boolean
  sessionPreviewCount: SessionPreviewCount
  sendKey: 'newline' | 'send'
  /** 会话运行中点发送键的默认处理。 */
  runningSend: RunningSendPreference
  imageCompression: ImageCompression
}

const storageKey = 'qn.mobile.preferences'
/**
 * 手机沿用以前的习惯：运行中点按排队，长按再由用户选引导或打断；电脑版默认引导，两端不共用默认值。
 * 选择存在 runningSendMode 字段：上一版把电脑版默认值「引导」写进过 runningSend，不能当作用户的选择。
 */
const MOBILE_RUNNING_SEND: RunningSendPreference = 'queue'
const defaults: MobilePreferences = {
  theme: 'dark', followSystemDark: false, reduceMotion: false, sessionPreviewCount: 6,
  sendKey: 'newline', runningSend: MOBILE_RUNNING_SEND, imageCompression: 'medium',
}

export function parseSessionPreviewCount(value: unknown): SessionPreviewCount {
  return SESSION_PREVIEW_COUNTS.find((count) => count === value) ?? defaults.sessionPreviewCount
}

export function parseImageCompression(value: unknown): ImageCompression {
  return IMAGE_COMPRESSIONS.find((item) => item === value) ?? defaults.imageCompression
}

export function parseMobileRunningSend(value: unknown): RunningSendPreference {
  return RUNNING_SEND_PREFERENCES.find((item) => item === value) ?? MOBILE_RUNNING_SEND
}

/** 旧版存过「石墨灰」（graphite）和「跟随系统」（system）：前者并入灰色，后者回到默认深色。 */
export function parseTheme(value: unknown): MobileTheme {
  if (value === 'gray' || value === 'graphite') return 'gray'
  return value === 'light' ? 'light' : defaults.theme
}

function readPreferences(): MobilePreferences {
  if (typeof window === 'undefined') return defaults
  try {
    const value: Partial<Record<keyof MobilePreferences | 'runningSendMode', unknown>> | null = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    return {
      theme: parseTheme(value?.theme),
      followSystemDark: value?.followSystemDark === true,
      reduceMotion: value?.reduceMotion === true,
      sessionPreviewCount: parseSessionPreviewCount(value?.sessionPreviewCount),
      sendKey: value?.sendKey === 'send' ? 'send' : defaults.sendKey,
      runningSend: parseMobileRunningSend(value?.runningSendMode),
      imageCompression: parseImageCompression(value?.imageCompression),
    }
  } catch {
    return defaults
  }
}

export const useMobilePreferences = create<MobilePreferences & {
  update: (values: Partial<MobilePreferences>) => boolean
}>((set, get) => ({
  ...readPreferences(),
  update: (values) => {
    const { theme, followSystemDark, reduceMotion, sessionPreviewCount, sendKey, runningSend, imageCompression } = get()
    const next = { theme, followSystemDark, reduceMotion, sessionPreviewCount, sendKey, runningSend, imageCompression, ...values }
    set(next)
    try {
      const { runningSend: runningSendMode, ...rest } = next
      window.localStorage.setItem(storageKey, JSON.stringify({ ...rest, runningSendMode }))
      return true
    } catch {
      return false
    }
  },
}))

let systemBarsSync = Promise.resolve()

export function useMobileAppearance() {
  const theme = useMobilePreferences((state) => state.theme)
  const followSystemDark = useMobilePreferences((state) => state.followSystemDark)
  const reduceMotion = useMobilePreferences((state) => state.reduceMotion)
  const [systemDark, setSystemDark] = useState(false)
  const effectiveTheme = followSystemDark && systemDark ? 'dark' : theme

  useLayoutEffect(() => {
    if (getWindowNativePort()) {
      let awaitingInitial = true
      const onSystemTheme = (light: boolean) => {
        awaitingInitial = false
        setSystemDark(!light)
      }
      window.__qnSystemTheme = onSystemTheme
      void callDevice<boolean>('appearance.systemTheme').then((light) => {
        // 读取期间系统可能已切换主题，优先使用原生层主动推送的值。
        if (awaitingInitial && typeof light === 'boolean') onSystemTheme(light)
      }).catch(() => undefined)
      return () => {
        awaitingInitial = false
        if (window.__qnSystemTheme === onSystemTheme) delete window.__qnSystemTheme
      }
    }

    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = () => setSystemDark(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme
    if (!getWindowNativePort()) return
    // 原生桥并行处理请求，按设置顺序更新系统栏图标。
    systemBarsSync = systemBarsSync.then(async () => {
      await callDevice('appearance.systemBars', { light: effectiveTheme === 'light' })
    }).catch(() => undefined)
  }, [effectiveTheme])

  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduceMotion)
  }, [reduceMotion])
}
