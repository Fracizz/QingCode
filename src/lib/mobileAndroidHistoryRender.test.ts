// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TUI_FRAME_MARKER,
  charCells,
  gridRuns,
  historyItems,
  lineSegments,
  paletteColor,
  renderHistoryPage,
  renderScreen,
  sgrSegments,
  stripSgr,
} from '../../mobile/android/web/historyRender.js'

describe('Android colored history lines', () => {
  const theme = { green: '#89d185', red: '#f48771' }

  it('parses basic, 256-color and RGB SGR runs from the default style on every line', () => {
    const segments = sgrSegments('\x1b[32m•\x1b[m Ran \x1b[0;1;38;5;196mgit\x1b[38;2;1;2;3m!\x1b[39;22m done', theme)
    expect(segments.map(segment => segment.text)).toEqual(['•', ' Ran ', 'git', '!', ' done'])
    expect(segments[0].style).toMatchObject({ fg: '#89d185' })
    expect(segments[1].style).toBeNull()
    expect(segments[2].style).toMatchObject({ fg: 'rgb(255,0,0)', bold: true })
    expect(segments[3].style).toMatchObject({ fg: 'rgb(1,2,3)', bold: true })
    expect(segments[4].style).toBeNull()
  })

  it('never keeps non-SGR escapes as text or control sequences', () => {
    expect(stripSgr('\x1b[31mred\x1b]52;c;x\x07')).toBe('red]52;c;x\x07')
    expect(sgrSegments('a\x1bb').map(segment => segment.text).join('')).toBe('ab')
  })

  it('detects markers and blank lines through colors and renders colored spans', () => {
    expect(historyItems(['\x1b[2m\x1b[m', '\x1b[2m  \x1b[m', TUI_FRAME_MARKER]).map(item => item.kind)).toEqual(['divider'])
    const host = document.createElement('pre')
    host.append(renderHistoryPage(document, ['plain', '\x1b[31merror\x1b[m   ', 'after'], theme))
    expect(host.textContent).toBe('plain\nerror\nafter\n')
    expect((host.querySelector('span') as HTMLElement).style.color).toBe('rgb(244, 135, 113)')
  })

  it('draws bold basic colors bright and dim text at half opacity, like xterm', () => {
    const palette = { red: '#f48771', brightRed: '#ffaaaa' }
    const [bold, bright, cube, plain] = [
      '\x1b[1;31mbold', '\x1b[91mbright', '\x1b[1;38;5;1mcube', '\x1b[31mplain',
    ].map(line => sgrSegments(line, palette)[0].style)
    expect(bold).toMatchObject({ fg: '#ffaaaa', bold: true })
    expect(bright).toMatchObject({ fg: '#ffaaaa' })
    // xterm 只对 16 色模式做粗体变亮，256 色保持原色。
    expect(cube).toMatchObject({ fg: '#f48771', bold: true })
    expect(plain).toMatchObject({ fg: '#f48771' })
    const host = document.createElement('pre')
    host.append(renderHistoryPage(document, ['\x1b[2mhint\x1b[m'], palette))
    expect((host.querySelector('span') as HTMLElement).style.opacity).toBe('0.5')
  })
})

// 模拟 xterm IBufferCell：只实现渲染用到的方法。
function cell(chars: string, { fg = -1, rgb = false, bold = false, width = 1, p256 = false } = {}) {
  return {
    getFgColorMode: () => (fg < 0 ? 0 : rgb ? 0x3000000 : p256 ? 0x2000000 : 0x1000000),
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

function line(cells: ReturnType<typeof cell>[], isWrapped = false) {
  return { isWrapped, getCell: (x: number) => cells[x], translateToString: () => cells.map(item => item.getChars()).join('') }
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

  it('brightens bold 16-color cells on the screen copy but not 256-color ones', () => {
    const theme = { green: '#89d185', brightGreen: '#b0d6aa' }
    const row = line([cell('a', { fg: 2, bold: true }), cell('b', { fg: 2, bold: true, p256: true }), cell('c', { fg: 2 })])
    expect(lineSegments(row, 3, theme).map(segment => segment.style?.fg)).toEqual(['#b0d6aa', '#89d185', '#89d185'])
  })

  it('collapses blank runs and turns TUI frame markers into dividers', () => {
    expect(historyItems(['a  ', '', '', '', 'b', '', TUI_FRAME_MARKER, '', 'c']).map(({ kind, text }) => ({ kind, text }))).toEqual([
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

  it('copies the visible screen with colors and no divider, continuing the history above', () => {
    const rows = [line([cell('$', { fg: 2 }), cell(' '), cell('l'), cell('s')]), line([cell(' ')])]
    const term = {
      rows: 2, cols: 4, options: { theme: { green: '#89d185' } },
      buffer: { active: { viewportY: 0, getLine: (y: number) => rows[y] } },
    }
    const host = document.createElement('pre')
    host.append(renderScreen(document, term))
    expect(host.querySelector('.history-divider')).toBeNull()
    expect((host.querySelector('span') as HTMLElement).style.color).toBe('rgb(137, 209, 133)')
    expect(host.textContent).toBe('$ ls\n')
  })

  it('rejoins soft-wrapped screen rows into one logical line, keeping the word gap', () => {
    const rows = [
      line([cell('a'), cell('b'), cell('c'), cell(' ')]),
      line([cell('d'), cell('e'), cell(' '), cell(' ')], true),
      line([cell('x')]),
    ]
    const term = {
      rows: 3, cols: 4, options: {},
      buffer: { active: { viewportY: 0, getLine: (y: number) => rows[y] } },
    }
    const host = document.createElement('pre')
    host.append(renderScreen(document, term))
    expect(host.textContent).toBe('abc de\nx')
  })
})

describe('Android history grid alignment', () => {
  it('measures cells like the terminal: CJK is two cells, box drawing one, combining zero', () => {
    expect(charCells('a'.codePointAt(0)!)).toBe(1)
    expect(charCells('─'.codePointAt(0)!)).toBe(1)
    expect(charCells('中'.codePointAt(0)!)).toBe(2)
    expect(charCells('，'.codePointAt(0)!)).toBe(2)
    expect(charCells(0x0301)).toBe(0)
  })

  it('splits ASCII from grid runs and counts their cells', () => {
    expect(gridRuns('│ 已随 │ ok──┤')).toEqual([
      { text: '│', cells: 1 },
      { text: ' ', cells: null },
      { text: '已随', cells: 4 },
      { text: ' ', cells: null },
      { text: '│', cells: 1 },
      { text: ' ok', cells: null },
      { text: '──┤', cells: 3 },
    ])
  })

  it('pins box drawing and CJK to terminal cell widths in history pages and the screen copy', () => {
    const host = document.createElement('pre')
    host.append(renderHistoryPage(document, ['├──┼──┤', '│ 最新 │', 'plain', '\x1b[31m中\x1b[m!']))
    expect(host.textContent).toBe('├──┼──┤\n│ 最新 │\nplain\n中!\n')
    const widths = [...host.querySelectorAll<HTMLElement>('.cells')].map(span => [span.textContent, span.style.width])
    expect(widths).toEqual([['├──┼──┤', '7ch'], ['│', '1ch'], ['最', '2ch'], ['新', '2ch'], ['│', '1ch'], ['中', '2ch']])

    const rows = [line([cell('中', { width: 2 }), cell('', { width: 0 }), cell('─')])]
    const term = { rows: 1, cols: 3, options: {}, buffer: { active: { viewportY: 0, getLine: (y: number) => rows[y] } } }
    const screen = document.createElement('pre')
    screen.append(renderScreen(document, term, text => ({ cell: 0.6, width: text.length * 1 })))
    const [wide, line_] = [...screen.querySelectorAll<HTMLElement>('.cells')]
    expect([wide.textContent, wide.style.width, wide.style.letterSpacing]).toEqual(['中', '2ch', '0.2000em'])
    expect([line_.textContent, line_.style.width]).toEqual(['─', '1ch'])
  })

  it('gives each wide character its own cell box so long CJK runs can wrap', () => {
    const host = document.createElement('pre')
    host.append(renderHistoryPage(document, ['平板宽网格́内容──']))
    expect(host.textContent).toBe('平板宽网格́内容──\n')
    // 组合字符跟随前一个字；表格线整段保留。
    expect([...host.querySelectorAll('.cells')].map(span => span.textContent)).toEqual(['平', '板', '宽', '网', '格́', '内', '容', '──'])
  })

  it('draws block elements per cell so rows join without gaps and text stays copyable', () => {
    const host = document.createElement('pre')
    host.append(renderHistoryPage(document, ['\x1b[38;2;215;119;87m▐▛█\x1b[m ─▌x']))
    expect(host.textContent).toBe('▐▛█ ─▌x\n')
    expect([...host.querySelectorAll('.block-cell')].map(span => span.textContent)).toEqual(['▐', '▛', '█', '▌'])
    expect([...host.querySelectorAll('.cells')].map(span => span.textContent)).toEqual(['─'])
  })
})
