import { describe, expect, it } from 'vitest'
import {
  annotationExcerpt,
  annotationLabel,
  buildAnnotatedMessage,
  quoteBlock,
  type Annotation,
} from './annotations'

const quote = (text: string, comment = ''): Annotation => ({ id: text, quote: text, comment })

describe('引用与注释拼接', () => {
  it('多行引用逐行加 > 并兼容 CRLF', () => {
    expect(quoteBlock('第一行\n第二行')).toBe('> 第一行\n> 第二行')
    expect(quoteBlock('a\r\nb\r')).toBe('> a\n> b')
    expect(quoteBlock('a\n\nb')).toBe('> a\n> \n> b')
  })

  it('拼接引用、可选评论与用户输入', () => {
    expect(buildAnnotatedMessage([quote('被选中的文字', '这里改一下')], '请修复'))
      .toBe('> 被选中的文字\n这里改一下\n\n请修复')
  })

  it('评论可空', () => {
    expect(buildAnnotatedMessage([quote('引用')], '继续'))
      .toBe('> 引用\n\n继续')
  })

  it('多条注释之间空一行，多行引用保持块引用格式', () => {
    expect(
      buildAnnotatedMessage(
        [quote('第一行\n第二行', '注释 A'), quote('第三行', '注释 B')],
        '一起处理',
      ),
    ).toBe('> 第一行\n> 第二行\n注释 A\n\n> 第三行\n注释 B\n\n一起处理')
  })

  it('没有注释时原样返回输入；只有注释时也能发送', () => {
    expect(buildAnnotatedMessage([], '  hello  ')).toBe('hello')
    expect(buildAnnotatedMessage([quote('引用', '看一下')], '  ')).toBe('> 引用\n看一下')
    expect(buildAnnotatedMessage([quote('  ')], '')).toBe('')
  })

  it('注释条文案与摘要', () => {
    expect(annotationLabel(3)).toBe('💬 3 条注释')
    expect(annotationExcerpt(quote('a\n  b'), 10)).toBe('a b')
    expect(annotationExcerpt(quote('abcdef'), 3)).toBe('abc…')
  })
})
