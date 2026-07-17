import { describe, expect, it } from 'vitest'
import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'
import {
  formatDocumentErrorToast,
  formatInvokeErrorMessage,
} from './formatDocument'

describe('formatDocument size gate', () => {
  it('aligns soft format cap with degraded-edit band (5 MB)', () => {
    expect(EDIT_DEGRADED_BYTES).toBe(5 * 1024 * 1024)
  })
})

describe('formatDocumentErrorToast', () => {
  it('strips Error: prefix', () => {
    expect(formatInvokeErrorMessage(new Error('未找到 ruff/black'))).toBe('未找到 ruff/black')
  })

  it('passes through 暂不支持 / 未找到 without wrapping', () => {
    expect(formatDocumentErrorToast('暂不支持格式化该语言/扩展名（.java）')).toBe(
      '暂不支持格式化该语言/扩展名（.java）',
    )
    expect(formatDocumentErrorToast('未找到 shfmt（请安装 shfmt 并加入 PATH）')).toBe(
      '未找到 shfmt（请安装 shfmt 并加入 PATH）',
    )
    expect(formatDocumentErrorToast('格式化失败: syntax')).toBe('格式化失败: syntax')
  })

  it('wraps opaque errors', () => {
    expect(formatDocumentErrorToast('boom')).toMatch(/格式化失败|Format failed/)
  })
})
