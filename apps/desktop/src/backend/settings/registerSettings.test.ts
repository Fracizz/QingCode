import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '../../shared/backendApi'
import { DEFAULT_FONT_SIZES } from '../../shared/fontSizes'
import { backendConfig } from '../config'
import { registerSettingsMethods } from '../registerSettings'
import { BackendRouter, RouterError } from '../router'

let userData = ''
let originalUserData = ''
let originalVersion = ''

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'qn-register-settings-'))
  originalUserData = backendConfig.userData
  originalVersion = backendConfig.appVersion
  backendConfig.userData = userData
  backendConfig.appVersion = '9.8.7'
})

afterEach(async () => {
  backendConfig.userData = originalUserData
  backendConfig.appVersion = originalVersion
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const router = (): BackendRouter => {
  const instance = new BackendRouter()
  registerSettingsMethods(instance)
  return instance
}

describe('registerSettingsMethods', () => {
  it('settings.get 返回默认值，app.info 带回应用版本', async () => {
    const instance = router()
    expect(await instance.invoke('settings.get', undefined)).toEqual({
      general: {
        sendKey: 'enter',
        autoConnectLast: true,
        defaultAgent: 'codex',
        density: 'comfortable',
        ...DEFAULT_FONT_SIZES,
      },
      agents: {},
    })
    expect(await instance.invoke('app.info', undefined)).toEqual({
      name: 'QingCode Next',
      version: '9.8.7',
    })
  })

  it('settings.save 深合并、白名单过滤并原子落盘', async () => {
    const instance = router()
    const first = (await instance.invoke('settings.save', {
      general: { sendKey: 'ctrlEnter', autoConnectLast: false },
      agents: { local: { codex: { enabled: false, path: 'C:\\bin\\codex.exe' } } },
    })) as AppSettings
    expect(first.general).toMatchObject({ sendKey: 'ctrlEnter', autoConnectLast: false, density: 'comfortable' })
    expect(first.agents.local?.codex).toEqual({ enabled: false, path: 'C:\\bin\\codex.exe' })

    const second = (await instance.invoke('settings.save', {
      general: { density: 'compact', theme: 'light' },
      agents: { local: { codex: { path: 'D:\\codex.exe' } }, 'ssh-1': { pi: { enabled: true } } },
    })) as AppSettings
    expect(second.general.sendKey).toBe('ctrlEnter')
    expect(second.general.density).toBe('compact')
    expect(second.agents.local?.codex).toEqual({ enabled: false, path: 'D:\\codex.exe' })
    expect(second.agents['ssh-1']?.pi).toEqual({ enabled: true })
    expect(JSON.stringify(second)).not.toContain('theme')

    expect(await instance.invoke('settings.get', undefined)).toEqual(second)
    const text = await readFile(join(userData, 'settings.json'), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ general: { density: 'compact' } })
  })

  it('连续保存不同的字号时保留两个设置', async () => {
    const instance = router()
    await Promise.all([
      instance.invoke('settings.save', { general: { chatFontSize: 18 } }),
      instance.invoke('settings.save', { general: { terminalFontSize: 16 } }),
    ])
    expect(await instance.invoke('settings.get', undefined)).toMatchObject({
      general: { ...DEFAULT_FONT_SIZES, chatFontSize: 18, terminalFontSize: 16 },
    })
  })

  it('非对象补丁给出 invalid_params，且不改动已存设置', async () => {
    const instance = router()
    await instance.invoke('settings.save', { general: { defaultAgent: 'pi' } })
    await expect(instance.invoke('settings.save', 42)).rejects.toBeInstanceOf(RouterError)
    try {
      await instance.invoke('settings.save', null)
      expect.unreachable('应当抛错')
    } catch (err) {
      expect((err as RouterError).code).toBe('invalid_params')
    }
    const stored = (await instance.invoke('settings.get', undefined)) as AppSettings
    expect(stored.general.defaultAgent).toBe('pi')
  })
})
