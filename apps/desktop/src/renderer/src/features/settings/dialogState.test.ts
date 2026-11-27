import { beforeEach, describe, expect, it } from 'vitest'
import { closeSettings, openSettings, useSettingsDialog } from './dialogState'

beforeEach(() => {
  useSettingsDialog.setState({ open: false, section: undefined })
})

describe('设置对话框全局开关', () => {
  it('openSettings 打开并可指定分类，closeSettings 复位', () => {
    openSettings('agents')
    expect(useSettingsDialog.getState().open).toBe(true)
    expect(useSettingsDialog.getState().section).toBe('agents')
    closeSettings()
    expect(useSettingsDialog.getState().open).toBe(false)
    expect(useSettingsDialog.getState().section).toBeUndefined()
  })

  it('未传分类或非法分类时按 undefined 处理', () => {
    openSettings()
    expect(useSettingsDialog.getState().section).toBeUndefined()
    useSettingsDialog.getState().openSettings('unknown' as never)
    expect(useSettingsDialog.getState().section).toBeUndefined()
    expect(useSettingsDialog.getState().open).toBe(true)
  })
})
