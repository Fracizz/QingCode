import { DEFAULT_RUNNING_SEND, parseRunningSend, t, type RunningSendPreference } from '@qn/codex-client'
import { create } from 'zustand'

// “运行中发送”只影响本机输入框，和模型偏好一样存 localStorage，不进后端设置文件。
export const RUNNING_SEND_STORAGE_KEY = 'qn-running-send'

export const RUNNING_SEND_SETTING_OPTIONS: ReadonlyArray<{ value: RunningSendPreference; label: string }> = [
  { value: 'steer', label: t('引导') },
  { value: 'queue', label: t('排队') },
  { value: 'interrupt', label: t('打断后发送') },
]

function readPreference(): RunningSendPreference {
  try {
    return parseRunningSend(localStorage.getItem(RUNNING_SEND_STORAGE_KEY))
  } catch {
    return DEFAULT_RUNNING_SEND
  }
}

export const useRunningSend = create<{
  preference: RunningSendPreference
  setPreference: (preference: RunningSendPreference) => void
}>((set) => ({
  preference: readPreference(),
  setPreference: (preference) => {
    set({ preference })
    try {
      localStorage.setItem(RUNNING_SEND_STORAGE_KEY, preference)
    } catch {
      // 存储不可写时本次运行仍然生效。
    }
  },
}))
