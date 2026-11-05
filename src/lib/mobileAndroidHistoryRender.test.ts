// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TUI_FRAME_MARKER,
  historyItems,
  lineSegments,
  paletteColor,
  renderHistoryPage,
  renderScreen,
} from '../../mobile/android/web/historyRender.js'

// 模拟 xterm IBufferCell：只实现渲染用到的方法。
function cell(chars: string, { fg = -1, rgb = false, bold = false, width = 1 } = {}) {
  return {
    getChars: () => chars,
    getWidth: () => width,
    isFgDefault: () => fg < 0,
    isFgRGB: () => rgb,
    isFgPalette: () => fg >= 0 && !rgb,
    getFgColor: () => fg,
    isBgDefault: () => true,
    isBgRGB: () => false,
    isBgPalette: () => false,
    getBgColor: () => 0,
    isBold: () => bold,
    isDim: () => false,
    isItalic: () => false,
    isUnderline: () => false,
    isInverse: () => false,
  }
}

function line(cells: ReturnType<typeof cell>[]) {
  return { getCell: (x: number) => cells[x], translateToString: () => cells.map(item => item.getChars()).join('') }
}

describe('Android history rendering', () => {
  it('maps xterm palette indexes to theme and cube colors', () => {
    expect(paletteColor(2, { green: '#89d185' })).toBe('#89d185')
    expect(paletteColor(16)).toBe('rgb(0,0,0)')
    expect(paletteColor(196)).toBe('rgb(255,0,0)')
    expect(paletteColor(232)).toBe('rgb(8,8,8)')
  })

  it('merges same-style cells, skips wide-char placeholders and trims trailing blanks', () => {
    const row = line([
      cell('•', { fg: 2 }), cell(' '), cell('中', { fg: 0xff8800, rgb: true, width: 2 }), cell('', { width: 0 }),
      cell('o', { bold: true }), cell('k', { bold: true }), cell(' '), cell(' '),
    ])
    const segments = lineSegments(row, 8, { green: '#89d185' })
    expect(segments.map(segment => segment.text)).toEqual(['•', ' ', '中', 'ok'])
    expect(segments[0].style).toMatchObject({ fg: '#89d185' })
    expect(segments[1].style).toBeNull()
    expect(segments[2].style).toMatchObject({ fg: '#ff8800' })
    expect(segments[3].style).toMatchObject({ bold: true, fg: null })
  })

  it('collapses blank runs and turns TUI frame markers into dividers', () => {
    expect(historyItems(['a  ', '', '', '', 'b', '', TUI_FRAME_MARKER, '', 'c'])).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: '' },
      { kind: 'text', text: 'b' },
      { kind: 'divider', text: '全屏画面' },
      { kind: 'text', text: 'c' },
    ])
  })

  it('keeps page text line-oriented for copying and reading', () => {
    const host = document.createElement('pre')
    host.append(renderHistoryPage(document, ['one', TUI_FRAME_MARKER, 'two']))
    expect(host.querySelectorAll('.history-divider')).toHaveLength(1)
    expect(host.textContent).toBe('one\n全屏画面two\n')
  })

  it('copies the visible screen with colors under a current-screen divider', () => {
    const rows = [line([cell('$', { fg: 2 }), cell(' '), cell('l'), cell('s')]), line([cell(' ')])]
    const term = {
      rows: 2, cols: 4, options: { theme: { green: '#89d185' } },
      buffer: { active: { viewportY: 0, getLine: (y: number) => rows[y] } },
    }
    const host = document.createElement('pre')
    host.append(renderScreen(document, term))
    expect(host.querySelector('.history-divider')!.textContent).toBe('当前画面')
    expect((host.querySelector('span:not(.history-divider)') as HTMLElement).style.color).toBe('rgb(137, 209, 133)')
    expect(host.textContent).toBe('当前画面$ ls\n')
  })
})
