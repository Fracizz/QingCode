import { t, translateMessage } from '@qn/codex-client'
import { create } from 'zustand'
import type {
  MobileDevice,
  MobileSettings,
  MobileSettingsInput,
} from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError } from '../lib/errors'

const COPY_NOTICE = t('已复制连接信息。含配对密码，请只发给自己')

type MobileState = {
  settings: MobileSettings | null
  devices: MobileDevice[]
  busy: string | null
  error: string | null
  notice: string | null
  manualCopy: string | null
  load: () => Promise<void>
  save: (patch: MobileSettingsInput) => Promise<MobileSettings | null>
  retry: () => Promise<MobileSettings | null>
  copyInfo: (address: string) => Promise<void>
  revoke: (id: string) => Promise<void>
  regenerate: () => Promise<void>
  dismissError: () => void
  dismissNotice: () => void
  clearManualCopy: () => void
}

// 多个动作可能交叠（加载 + 复制），用计数避免先完成的动作提前清掉忙碌态。
let active = 0

export const useMobile = create<MobileState>((set, get) => {
  const run = async <T,>(label: string, failure: string, task: () => Promise<T>): Promise<T | null> => {
    active += 1
    set({ busy: label, error: null })
    try {
      return await task()
    } catch (err) {
      set({ error: friendlyError(err, failure) })
      return null
    } finally {
      active -= 1
      if (active === 0) set({ busy: null })
    }
  }

  const refreshDevices = async (): Promise<void> => {
    set({ devices: await call('mobile.devices') })
  }

  return {
    settings: null,
    devices: [],
    busy: null,
    error: null,
    notice: null,
    manualCopy: null,

    load: async () => {
      await run(t('加载手机连接设置'), t('加载手机连接设置失败'), async () => {
        const [nextSettings, devices] = await Promise.all([
          call('mobile.getSettings'),
          call('mobile.devices'),
        ])
        set({ settings: nextSettings, devices })
      })
    },

    save: (patch) =>
      run(t('保存手机连接设置'), t('保存手机连接设置失败'), async () => {
        const next = await call('mobile.saveSettings', patch)
        set({ settings: next, notice: t('设置已保存') })
        return next
      }),

    // 空补丁会让后端重新应用设置，用于端口占用等启动失败后的重试。
    retry: () =>
      run(t('重新启动手机网关'), t('重新启动手机网关失败'), async () => {
        const next = await call('mobile.saveSettings', {})
        set({ settings: next })
        return next
      }),

    copyInfo: async (address) => {
      await run(t('复制连接信息'), t('复制连接信息失败'), async () => {
        const info = await call('mobile.connectionInfo', { address })
        set({ manualCopy: null })
        // backend 按中文生成连接信息，复制前换成当前语言。
        const text = translateMessage(info.text)
        try {
          if (!navigator.clipboard?.writeText) throw new Error(t('剪贴板不可用'))
          await navigator.clipboard.writeText(text)
          set({ notice: COPY_NOTICE })
        } catch {
          // 剪贴板不可用时给出可手动选中的明文，不写日志、不自动持久化。
          set({ manualCopy: text, error: t('无法写入剪贴板，请手动复制下方连接信息') })
        }
      })
    },

    revoke: async (id) => {
      await run(t('撤销设备'), t('撤销设备失败'), async () => {
        await call('mobile.revokeDevice', { id })
        await refreshDevices()
        set({ notice: t('设备已撤销') })
      })
    },

    regenerate: async () => {
      await run(t('重新生成证书'), t('重新生成证书失败'), async () => {
        const result = await call('mobile.regenerateCert')
        await refreshDevices()
        set((state) => ({
          settings: state.settings
            ? { ...state.settings, fingerprint: result.fingerprint }
            : state.settings,
          notice: t('证书已重新生成，所有配对已解除，请从电脑重新复制连接信息'),
        }))
      })
    },

    dismissError: () => set({ error: null }),
    dismissNotice: () => set({ notice: null }),
    clearManualCopy: () => {
      set({ manualCopy: null })
      if (get().error) set({ error: null })
    },
  }
})
