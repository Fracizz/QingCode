import { describe, expect, it } from 'vitest'
import { resolveMarkdownLocalImagePath } from './markdownLocalImages'

describe('resolveMarkdownLocalImagePath', () => {
  const markdownPath = 'D:\\Download\\新平台CICD发布配置使用说明.md'

  it('resolves a relative image beside an independently opened Markdown file', () => {
    expect(
      resolveMarkdownLocalImagePath(markdownPath, '新平台CICD发布配置说明图/01-发布配置总览.png'),
    ).toBe('D:/Download/新平台CICD发布配置说明图/01-发布配置总览.png')
  })

  it('normalizes parent segments and URL-encoded file names', () => {
    expect(resolveMarkdownLocalImagePath(markdownPath, '../assets/my%20image.png?raw=1#top')).toBe(
      'D:/assets/my image.png',
    )
  })

  it('keeps absolute Windows and file URLs local', () => {
    expect(resolveMarkdownLocalImagePath(markdownPath, 'C:\\images\\diagram.png')).toBe(
      'C:/images/diagram.png',
    )
    expect(resolveMarkdownLocalImagePath(markdownPath, 'file:///C:/images/diagram.png')).toBe(
      'C:/images/diagram.png',
    )
  })

  it('leaves remote and embedded images to the WebView', () => {
    expect(resolveMarkdownLocalImagePath(markdownPath, 'https://example.com/image.png')).toBeNull()
    expect(resolveMarkdownLocalImagePath(markdownPath, 'data:image/png;base64,abc')).toBeNull()
    expect(resolveMarkdownLocalImagePath(markdownPath, 'blob:https://example.com/id')).toBeNull()
  })
})
