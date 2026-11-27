import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, AppSettingsPatch } from '../../../../shared/backendApi'
import { BackendCallError } from '../../lib/backend'
import { defaultAppSettings, mergeAppSettings } from './settingsModel'
import { applyDensity, useSettings } from './settingsStore'

const { callMock, setAttribute, setProperty } = vi.hoisted(() => ({
  callMock: vi.fn(),
  setAttribute: vi.fn(),
  setProperty: vi.fn(),
}))

vi.mock('../../lib/backend', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, call: callMock }
})

const APP_INFO = { name: 'QingCode Next', version: '1.2.3' }
let stored: AppSettings

const fakeBackend = (): void => {
  callMock.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'settings.get':
        return stored
      case 'app.info':
        return APP_INFO
      case 'settings.save': {
        stored = mergeAppSettings(stored, (params ?? {}) as AppSettingsPatch)
        return stored
      }
      default:
        throw new Error(`未知方法 ${method}`)
    }
  })
}

beforeEach(() => {
  stored = defaultAppSettings()
  callMock.mockReset()
  setAttribute.mockReset()
  setProperty.mockReset()
  fakeBackend()
  vi.stubGlobal('document', { documentElement: { setAttribute, style: { setProperty } } })
  useSettings.setState({
    settings: defaultAppSettings(),
    appInfo: null,
    loaded: false,
    loading: false,
    saving: false,
    error: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('settingsStore', () => {
  it('load 读取设置与应用信息，并写入密度 token 钩子', async () => {
    stored = mergeAppSettings(stored, { general: { density: 'compact', chatFontSize: 18 } })
    await useSettings.getState().load()
    const state = useSettings.getState()
    expect(state.loaded).toBe(true)
    expect(state.appInfo).toEqual(APP_INFO)
    expect(state.settings.general.density).toBe('compact')
    expect(state.error).toBeNull()
    expect(setAttribute).toHaveBeenCalledWith('data-density', 'compact')
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
    expect(setProperty).toHaveBeenCalledWith('--qn-chat-font-size', '18px')
  })

  it('load 失败时给出友好错误且不覆盖已有值', async () => {
    callMock.mockRejectedValueOnce(new BackendCallError('internal', '读取失败'))
    await useSettings.getState().load()
    expect(useSettings.getState().error).toContain('读取失败')
    expect(useSettings.getState().settings).toEqual(defaultAppSettings())
  })

  it('update 先乐观更新，成功后以服务端结果为准', async () => {
    const promise = useSettings.getState().update({ general: { sendKey: 'ctrlEnter' } })
    expect(useSettings.getState().settings.general.sendKey).toBe('ctrlEnter')
    expect(useSettings.getState().saving).toBe(true)
    await promise
    expect(useSettings.getState().settings.general.sendKey).toBe('ctrlEnter')
    expect(stored.general.sendKey).toBe('ctrlEnter')
    expect(useSettings.getState().saving).toBe(false)
    expect(useSettings.getState().error).toBeNull()
  })

  it('保存失败回滚到更新前的设置', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'settings.get') return stored
      if (method === 'app.info') return APP_INFO
      if (method === 'settings.save') throw new BackendCallError('internal', '磁盘已满')
      throw new Error(`未知方法 ${method}`)
    })
    const update = useSettings.getState().update({ general: { density: 'compact', theme: 'light', defaultAgent: 'pi', editorFontSize: 16 } })
    expect(setProperty).toHaveBeenLastCalledWith('--qn-editor-font-size', '16px')
    expect(setAttribute).toHaveBeenLastCalledWith('data-theme', 'light')
    await update
    expect(useSettings.getState().settings).toEqual(defaultAppSettings())
    expect(useSettings.getState().error).toContain('磁盘已满')
    expect(useSettings.getState().saving).toBe(false)
    expect(setAttribute.mock.calls.slice(-2)).toEqual([
      ['data-density', 'comfortable'],
      ['data-theme', 'dark'],
    ])
    expect(setProperty).toHaveBeenLastCalledWith('--qn-editor-font-size', '12.5px')
  })

  it('并发编辑中较早的失败不回滚更晚的编辑', async () => {
    const gate: { release?: () => void } = {}
    callMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'settings.get') return stored
      if (method === 'app.info') return APP_INFO
      if (method === 'settings.save') {
        const patch = (params ?? {}) as AppSettingsPatch
        if (patch.general?.sendKey === 'ctrlEnter') {
          // 第一次保存挂起，让第二次先完成，检验失败分支不会整体回滚。
          await new Promise<void>((resolve) => { gate.release = resolve })
          throw new BackendCallError('internal', '磁盘已满')
        }
        stored = mergeAppSettings(stored, patch)
        return stored
      }
      throw new Error(`未知方法 ${method}`)
    })

    const first = useSettings.getState().update({ general: { sendKey: 'ctrlEnter' } })
    const second = useSettings.getState().update({ general: { defaultAgent: 'pi' } })
    await second
    expect(useSettings.getState().settings.general.defaultAgent).toBe('pi')
    gate.release?.()
    await first
    expect(useSettings.getState().settings.general.defaultAgent).toBe('pi')
    expect(useSettings.getState().settings.general.sendKey).toBe('enter')
    expect(useSettings.getState().error).toContain('磁盘已满')
  })

  it('density 钩子在没有 document 时不报错', () => {
    vi.unstubAllGlobals()
    expect(() => applyDensity('compact')).not.toThrow()
  })
})
