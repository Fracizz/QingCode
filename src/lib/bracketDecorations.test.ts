import { describe, expect, it } from 'vitest'
import {
  activeGuideColumnForLine,
  activeIndentGuideForLines,
  blockGuideColumn,
  bracketGuideColumn,
  bracketGuideLineRange,
  buildGuideBoxShadow,
  findActiveGuidePair,
  findEnclosingPair,
  guideColumnsForLine,
  indentGuideColumnsForLine,
  indentLevelsForLines,
  scanBracketPairs,
  snapIndentLane,
} from './bracketDecorations'

describe('scanBracketPairs', () => {
  it('pairs nested brackets with depth', () => {
    const pairs = scanBracketPairs('a(b[c]{d})e')
    expect(pairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ open: 3, close: 5, depth: 1, openCh: '[' }),
        expect.objectContaining({ open: 6, close: 8, depth: 1, openCh: '{' }),
        expect.objectContaining({ open: 1, close: 9, depth: 0, openCh: '(' }),
      ]),
    )
  })

  it('ignores unmatched closers', () => {
    expect(scanBracketPairs(')a(b)')).toEqual([
      expect.objectContaining({ open: 2, close: 4, openCh: '(' }),
    ])
  })
})

describe('findEnclosingPair', () => {
  it('returns innermost pair containing the cursor', () => {
    const pairs = scanBracketPairs('f(a[b]c)')
    // positions: f ( a [ b ] c )
    //            0 1 2 3 4 5 6 7
    expect(findEnclosingPair(pairs, 4)?.openCh).toBe('[')
    expect(findEnclosingPair(pairs, 2)?.openCh).toBe('(')
    expect(findEnclosingPair(pairs, 0)).toBeNull()
  })

  it('includes the open and close bracket positions', () => {
    const pairs = scanBracketPairs('{\n  a\n}')
    // `{` at 0, `}` at last index
    expect(findEnclosingPair(pairs, 0)?.openCh).toBe('{')
    const close = pairs[0]?.close
    expect(close).toBeDefined()
    expect(findEnclosingPair(pairs, close!)?.openCh).toBe('{')
  })
})

describe('activeIndentGuideColumn', () => {
  it('uses snap indent lane for cursor line indent', () => {
    expect(snapIndentLane(6, 2)).toBe(6)
    expect(snapIndentLane(5, 4)).toBe(4)
  })
})

describe('buildGuideBoxShadow', () => {
  it('emits solid box-shadow offsets (no gradient / dash)', () => {
    const shadow = buildGuideBoxShadow([2, 4], 8, 4)
    expect(shadow).toContain('16px 0 0 0')
    expect(shadow).toContain('32px 0 0 0')
    expect(shadow).toContain('var(--editor-indent-guide-active)')
    expect(shadow).not.toContain('linear-gradient')
    expect(shadow).not.toContain('repeating')
  })
})

describe('activeGuideColumnForLine', () => {
  const bracket = { fromLine: 6, toLine: 10, column: 4 }
  const indent = { fromLine: 7, toLine: 8, column: 8, level: 3 }

  it('uses one bracket guide first, then one scoped indent guide', () => {
    expect(activeGuideColumnForLine(7, bracket, indent)).toBe(4)
    expect(activeGuideColumnForLine(7, null, indent)).toBe(8)
    expect(activeGuideColumnForLine(3, bracket, indent)).toBeNull()
  })
})

describe('indentGuideColumnsForLine', () => {
  it('lists every VS Code indentation level from the outermost lane', () => {
    expect(indentGuideColumnsForLine('    const x = 1', 2)).toEqual([0, 2])
    expect(indentGuideColumnsForLine('      {', 2)).toEqual([0, 2, 4])
    expect(indentGuideColumnsForLine('        "id": 1', 2)).toEqual([0, 2, 4, 6])
    expect(indentGuideColumnsForLine('export function f() {', 2)).toEqual([])
  })
})

describe('guideColumnsForLine', () => {
  it('keeps the active guide when ordinary guides are suppressed', () => {
    expect(guideColumnsForLine(2, 4, false, 4)).toEqual([4])
    expect(guideColumnsForLine(2, 4, false, null)).toEqual([])
  })
})

describe('VS Code active indentation scope', () => {
  const lines = [
    'def f():',
    '    if first:',
    '        one()',
    '        two()',
    '    if second:',
    '        three()',
    '    return None',
  ]

  it('highlights only the contiguous Python block containing the cursor', () => {
    expect(activeIndentGuideForLines(lines, 3, 4, true)).toEqual({
      fromLine: 3,
      toLine: 4,
      level: 2,
      column: 4,
    })
  })

  it('selects a child block from its opener without activating siblings', () => {
    expect(activeIndentGuideForLines(lines, 5, 4, true)).toEqual({
      fromLine: 6,
      toLine: 6,
      level: 2,
      column: 4,
    })
  })

  it('uses Python off-side rules for blank lines at a dedent', () => {
    const withBlank = ['if ok:', '    work()', '', 'done()']
    expect(indentLevelsForLines(withBlank, 4, true)).toEqual([0, 1, 0, 0])
  })
})

describe('findActiveGuidePair', () => {
  it('prefers the pair opening on the cursor line even in leading whitespace', () => {
    const text = '{\n  [\n    {\n      a\n    }\n  ]\n}'
    const pairs = scanBracketPairs(text)
    const lines = text.split('\n')
    const lineOfPos = (i: number) => {
      let from = 0
      for (let n = 1; n <= lines.length; n++) {
        const to = from + lines[n - 1].length
        if (i <= to) return { number: n }
        from = to + 1
      }
      return { number: lines.length }
    }
    // Line 3 is `    {` — caret in leading spaces (before `{`).
    const lineStart = lines[0].length + 1 + lines[1].length + 1
    const lineEnd = lineStart + lines[2].length
    const pair = findActiveGuidePair(pairs, lineStart, lineStart, lineEnd, lineOfPos)
    expect(pair?.openCh).toBe('{')
    expect(pair?.depth).toBe(2)
  })
})

describe('blockGuideColumn', () => {
  const tab = 2

  it('uses inner body indent for function blocks', () => {
    const lines = [
      { number: 1, text: 'export function f() {' },
      { number: 2, text: '  const x = 1' },
      { number: 14, text: '}' },
    ]
    expect(blockGuideColumn(lines, 1, 14, tab)).toBe(0)
  })

  it('uses brace column when brace is alone on the line (JSON)', () => {
    const lines = [
      { number: 3, text: '      {' },
      { number: 4, text: '        "id": "x"' },
      { number: 8, text: '      }' },
    ]
    expect(blockGuideColumn(lines, 3, 8, tab, 6)).toBe(6)
  })

  it('uses key indent for JSON arrays ("tasks": [ … ])', () => {
    const lines = [
      { number: 1, text: '    "tasks": [' },
      { number: 2, text: '      {' },
      { number: 3, text: '        "id": "x"' },
      { number: 4, text: '      }' },
      { number: 5, text: '    ]' },
    ]
    expect(blockGuideColumn(lines, 1, 5, tab, 14)).toBe(4)
  })
})

describe('bracketGuideColumn', () => {
  const tab = 4

  it('aligns with inner block indent (VS / Cursor style)', () => {
    const lines = [
      { number: 1, text: '    "browser": {' },
      { number: 2, text: '        "preferred": "msedge",' },
      { number: 3, text: '    }' },
    ]
    expect(bracketGuideColumn(lines, 1, 3, 15, 4, tab)).toBe(4)
  })

  it('uses close-line indent for empty blocks', () => {
    const lines = [
      { number: 1, text: '    "x": {' },
      { number: 2, text: '    }' },
    ]
    expect(bracketGuideColumn(lines, 1, 2, 10, 4, tab)).toBe(4)
  })
})

describe('bracketGuideLineRange', () => {
  it('spans open through close lines inclusive (VS-style continuous rail)', () => {
    expect(bracketGuideLineRange(14, 30)).toEqual({ from: 14, to: 30 })
  })

  it('keeps a short rail for adjacent brace lines', () => {
    expect(bracketGuideLineRange(10, 11)).toEqual({ from: 10, to: 11 })
  })

  it('skips same-line pairs', () => {
    expect(bracketGuideLineRange(5, 5)).toBeNull()
  })
})
