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

  it('translates 暂不支持 / 未找到 without wrapping', () => {
    expect(formatDocumentErrorToast('暂不支持 Python 格式化')).toMatch(
      /暂不支持 Python 格式化|Python formatting is not supported yet/,
    )
    expect(formatDocumentErrorToast('暂不支持格式化该语言/扩展名（.java）')).toMatch(
      /暂不支持格式化该语言\/扩展名（\.java）|Formatting is not supported for this language\/extension \(\.java\)/,
    )
    expect(formatDocumentErrorToast('未找到 shfmt。请安装 shfmt 并加入 PATH')).toMatch(
      /未找到 shfmt|shfmt was not found/,
    )
    expect(formatDocumentErrorToast('格式化失败: syntax')).toMatch(/格式化失败: syntax|Format failed: syntax/)
  })

  it('wraps opaque errors', () => {
    expect(formatDocumentErrorToast('boom')).toMatch(/格式化失败|Format failed/)
  })
})
