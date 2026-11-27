import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from './markdown'

describe('复制为纯文本', () => {
  it('去掉标题、列表、引用、强调、行内代码与链接语法但保留文字', () => {
    const source = [
      '# 标题',
      '',
      '- **第一步** 运行 `npm test`',
      '> 引用文字',
      '',
      '见 [文档](https://example.com/a) 与 ![截图](https://example.com/b.png)',
    ].join('\n')
    expect(markdownToPlainText(source)).toBe(
      ['标题', '', '第一步 运行 npm test', '引用文字', '', '见 文档 与 截图'].join('\n'),
    )
  })

  it('代码块只去掉围栏，保留代码内容', () => {
    expect(markdownToPlainText('```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('多余空行合并、CRLF 统一', () => {
    expect(markdownToPlainText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb')
  })
})
