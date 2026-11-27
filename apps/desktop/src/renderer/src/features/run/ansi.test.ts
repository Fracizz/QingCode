import { describe, expect, it } from 'vitest'
import { applySgr, color256, initialAnsiState, parseAnsi, stripAnsi, styleToCss } from './ansi'

const texts = (input: string): Array<[string, Record<string, unknown>]> =>
  parseAnsi(input, initialAnsiState()).segments.map((s) => [s.text, { ...s.style }])

describe('parseAnsi', () => {
  it('SGR 颜色、粗体与重置', () => {
    expect(texts('a\u001b[31mred\u001b[1mbold\u001b[0mplain')).toEqual([
      ['a', {}],
      ['red', { fg: '#f14c4c' }],
      ['bold', { fg: '#f14c4c', bold: true }],
      ['plain', {}],
    ])
  })

  it('亮色、背景、256 色与真彩色', () => {
    expect(applySgr({}, [92, 44])).toEqual({ fg: '#6fcf8f', bg: '#3b8eea' })
    expect(applySgr({}, [38, 5, 196]).fg).toBe(color256(196))
    expect(applySgr({}, [48, 2, 1, 2, 255]).bg).toBe('#0102ff')
    expect(applySgr({ fg: '#fff', bold: true }, [39, 22])).toEqual({})
    expect(applySgr({ fg: '#fff' }, [])).toEqual({})
  })

  it('去掉非 SGR 转义（光标移动、清屏、OSC 标题、私有模式）', () => {
    expect(stripAnsi('\u001b[2J\u001b[1;1Hx\u001b]0;title\u0007y\u001b[?25lz\u001b(Bw\u001b]8;;http://a\u001b\\link')).toBe('xyzwlink')
  })

  it('跨块切断的转义序列留到下一块', () => {
    const first = parseAnsi('ok\u001b[3', initialAnsiState())
    expect(first.segments.map((s) => s.text)).toEqual(['ok'])
    expect(first.state.pending).toBe('\u001b[3')
    const second = parseAnsi('2mgreen', first.state)
    expect(second.segments).toEqual([{ text: 'green', style: { fg: '#23d18b' } }])
    expect(parseAnsi('x\u001b', initialAnsiState()).state.pending).toBe('\u001b')
  })

  it('样式跨块延续，控制字符被去掉但保留换行和制表符', () => {
    const first = parseAnsi('\u001b[33m', initialAnsiState())
    const second = parseAnsi('a\tb\u0007\n', first.state)
    expect(second.segments).toEqual([{ text: 'a\tb\n', style: { fg: '#f5f543' } }])
  })

  it('styleToCss', () => {
    expect(styleToCss({ fg: '#f00', bold: true, underline: true, dim: true, italic: true })).toEqual({
      color: '#f00',
      fontWeight: '600',
      textDecoration: 'underline',
      opacity: '0.65',
      fontStyle: 'italic',
    })
    expect(styleToCss({ fg: '#f00', inverse: true })).toEqual({ color: 'var(--color-qn-panel)', backgroundColor: '#f00' })
  })
})
