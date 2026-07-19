import { describe, expect, it } from 'vitest'
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, normalizePtySize } from './terminalPtySize'

describe('normalizePtySize', () => {
  it('keeps valid dimensions', () => {
    expect(normalizePtySize(120, 40)).toEqual({ cols: 120, rows: 40 })
  })

  it('clamps to min/max and floors fractions', () => {
    expect(normalizePtySize(1, 0)).toEqual({ cols: 2, rows: DEFAULT_PTY_ROWS })
    expect(normalizePtySize(120.9, 40.2)).toEqual({ cols: 120, rows: 40 })
    expect(normalizePtySize(5000, 900)).toEqual({ cols: 1000, rows: 500 })
  })

  it('falls back for non-finite values', () => {
    expect(normalizePtySize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
    })
  })
})
