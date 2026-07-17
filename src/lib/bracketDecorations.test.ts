import { describe, expect, it } from 'vitest'
import { findEnclosingPair, scanBracketPairs } from './bracketDecorations'

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
})
