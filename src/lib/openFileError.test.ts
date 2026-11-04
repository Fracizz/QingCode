import { describe, expect, it } from 'vitest'
import {
  binaryFileTypeLabel,
  canPreviewAnyway,
  canRetryOpen,
  fileExtension,
  fileExtensionLabel,
  isBinaryExtension,
  isLoadingTab,
  openFileErrorTitle,
  parseOpenFileError,
  tabNeedsDiskContent,
} from './openFileError'

describe('parseOpenFileError', () => {
  it('classifies detection failures as encoding errors without a double prefix', () => {
    const detectFailed = parseOpenFileError('无法识别文件编码（binary content）：install.sh')
    expect(detectFailed.kind).toBe('encoding')
    // Never leak the decoder's English plumbing into the UI.
    expect(detectFailed.message).toBe('无法识别文件编码（二进制内容）：install.sh')

    expect(parseOpenFileError('无法识别文件编码（unsupported text encoding）：a.txt').kind).toBe(
      'encoding',
    )
    expect(parseOpenFileError('暂不支持打开非文本或无法按 utf8 解码的文件：a.sh').kind).toBe(
      'encoding',
    )
  })

  it('classifies remote binary reads by extension instead of blaming the encoding', () => {
    const remotePng = parseOpenFileError(
      '检测远程文件编码失败：binary content',
      'ssh://23a6efe9-51bb-4121-9d8c-41538a91d6b2/D:/code/nem-panel/shot.png',
    )
    expect(remotePng.kind).toBe('binary')
    expect(remotePng.message).toBe('远程文件包含二进制内容，不是文本文件')

    expect(
      parseOpenFileError('暂不支持在文本编辑器中打开 .png 格式（二进制文件）：shot.png').kind,
    ).toBe('binary')
  })

  it('keeps the read-only preview escape hatch for extensionless binary payloads', () => {
    const unknown = parseOpenFileError('检测远程文件编码失败：binary content', 'ssh://c1/tmp/blob')
    expect(unknown.kind).toBe('encoding')
    expect(canPreviewAnyway(unknown.kind)).toBe(true)
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

  it('does not blame local encryption software for a remote decode failure', () => {
    expect(openFileErrorTitle('encoding', { remote: true })).not.toContain('加密软件')
    expect(openFileErrorTitle('encoding', { remote: true })).toBe('文件内容无法按当前编码解码。')
  })
})

describe('binary file copy', () => {
  it('names the file type instead of showing decoder jargon', () => {
    expect(binaryFileTypeLabel('ssh://c1/D:/app/shot.png')).toBe('图片')
    expect(binaryFileTypeLabel('/tmp/report.PDF')).toBe('PDF 文档')
    expect(binaryFileTypeLabel('/tmp/bundle.zip')).toBe('压缩包')
    expect(binaryFileTypeLabel('/tmp/main.rs')).toBeNull()
    expect(binaryFileTypeLabel('/tmp/blob')).toBeNull()
  })

  it('reads extensions without the dot for display', () => {
    expect(fileExtension('/tmp/Shot.PNG')).toBe('png')
    expect(fileExtensionLabel('/tmp/Shot.PNG')).toBe('.png')
    expect(fileExtensionLabel('/tmp/Makefile')).toBe('')
    expect(isBinaryExtension('/tmp/shot.png')).toBe(true)
    expect(isBinaryExtension('/tmp/main.rs')).toBe(false)
  })

  it('retries only failures that may be transient', () => {
    expect(canRetryOpen('binary')).toBe(false)
    expect(canRetryOpen('too-large')).toBe(false)
    expect(canRetryOpen('encoding')).toBe(true)
    expect(canRetryOpen('access')).toBe(true)
    expect(canRetryOpen('generic')).toBe(true)
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
