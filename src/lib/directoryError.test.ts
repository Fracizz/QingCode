import { beforeEach, describe, expect, it } from 'vitest'
import { useLocaleStore } from './i18n'
import {
  formatDirectoryErrorDetail,
  formatExpandDirErrorToast,
} from './directoryError'

describe('formatDirectoryErrorDetail', () => {
  beforeEach(() => {
    useLocaleStore.getState().setLanguage('zh-CN')
  })

  it('localizes Chinese source key with path', () => {
    expect(formatDirectoryErrorDetail('目录不可用: D:\\tmp\\gone')).toBe(
      '目录不可用: D:\\tmp\\gone',
    )
    useLocaleStore.getState().setLanguage('en')
    expect(formatDirectoryErrorDetail('目录不可用: D:\\tmp\\gone')).toBe(
      'Directory is unavailable: D:\\tmp\\gone',
    )
  })

  it('accepts legacy English backend form', () => {
    useLocaleStore.getState().setLanguage('en')
    expect(
      formatDirectoryErrorDetail(
        new Error('Directory is unavailable: D:\\WorkSpace\\code\\qing-code\\deps'),
      ),
    ).toBe('Directory is unavailable: D:\\WorkSpace\\code\\qing-code\\deps')
  })
})

describe('formatExpandDirErrorToast', () => {
  beforeEach(() => {
    useLocaleStore.getState().setLanguage('zh-CN')
  })

  it('wraps unavailable detail for zh-CN and en', () => {
    const path = 'D:\\WorkSpace\\code\\qing-code\\src-tauri\\target\\debug\\deps\\rustcJ8UDd9'
    expect(formatExpandDirErrorToast(`目录不可用: ${path}`)).toBe(
      `展开目录失败: 目录不可用: ${path}`,
    )
    useLocaleStore.getState().setLanguage('en')
    expect(formatExpandDirErrorToast(`Directory is unavailable: ${path}`)).toBe(
      `Failed to expand folder: Directory is unavailable: ${path}`,
    )
  })
})
