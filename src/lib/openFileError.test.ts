import { describe, expect, it } from 'vitest'
import {
  canPreviewAnyway,
  isLoadingTab,
  openFileErrorTitle,
  parseOpenFileError,
  tabNeedsDiskContent,
} from './openFileError'

describe('parseOpenFileError', () => {
  it('classifies detection failures as encoding errors without a double prefix', () => {
    const detectFailed = parseOpenFileError('无法识别文件编码（binary content）：install.sh')
    expect(detectFailed.kind).toBe('encoding')
    expect(detectFailed.message).toBe('无法识别文件编码（binary content）：install.sh')

    expect(parseOpenFileError('无法识别文件编码（unsupported text encoding）：a.txt').kind).toBe(
      'encoding',
    )
    expect(parseOpenFileError('暂不支持打开非文本或无法按 utf8 解码的文件：a.sh').kind).toBe(
      'encoding',
    )
  })

  it('keeps extension-blocked formats as binary and unknown failures as generic', () => {
    expect(parseOpenFileError('暂不支持打开 .png 格式（非文本文件），请用对应应用打开：a.png').kind)
      .toBe('binary')
    expect(parseOpenFileError('something odd').message).toBe('打开文件失败：something odd')
  })

  it('offers the read-only preview escape hatch only for decode failures', () => {
    expect(canPreviewAnyway('encoding')).toBe(true)
    expect(canPreviewAnyway('binary')).toBe(false)
    expect(canPreviewAnyway('too-large')).toBe(false)
    expect(canPreviewAnyway('generic')).toBe(false)
  })

  it('guides decode failures caused by transparent-encryption software', () => {
    expect(openFileErrorTitle('encoding')).toContain('加密软件')
    expect(openFileErrorTitle('encoding')).toContain('密文字节')
    expect(openFileErrorTitle('binary')).not.toContain('密文字节')
  })
})

describe('isLoadingTab', () => {
  it('treats progressive open (no content yet) as loading', () => {
    expect(isLoadingTab({ loading: true })).toBe(true)
    expect(isLoadingTab({ content: undefined })).toBe(true)
  })

  it('does not treat plain-profile buffer clear as loading', () => {
    // After bind, plain tabs drop the Zustand duplicate but keep disk metadata.
    expect(
      isLoadingTab({
        content: undefined,
        fileSize: 30 * 1024 * 1024,
        diskMtime: 1,
      }),
    ).toBe(false)
  })

  it('keeps view-mode tabs loading only while the flag is set', () => {
    expect(isLoadingTab({ viewMode: 'view', loading: true })).toBe(true)
    expect(isLoadingTab({ viewMode: 'view', loading: false, fileSize: 1 })).toBe(false)
  })
})

describe('tabNeedsDiskContent', () => {
  it('requests load for session-restored edit tabs', () => {
    expect(tabNeedsDiskContent({ content: undefined })).toBe(true)
  })

  it('skips plain tabs that already opened (content cleared on purpose)', () => {
    expect(
      tabNeedsDiskContent({
        content: undefined,
        fileSize: 30 * 1024 * 1024,
        diskMtime: 1,
      }),
    ).toBe(false)
  })

  it('still refreshes mtime when draft content exists without diskMtime', () => {
    expect(tabNeedsDiskContent({ content: 'draft', diskMtime: undefined })).toBe(true)
  })
})
