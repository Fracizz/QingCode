import { describe, expect, it } from 'vitest'
import { formatAppMemoryMb } from './appMemory'

describe('formatAppMemoryMb', () => {
  it('formats small values with one decimal', () => {
    expect(formatAppMemoryMb(3.2 * 1024 * 1024)).toBe('3.2 MB')
  })

  it('rounds larger values to integers', () => {
    expect(formatAppMemoryMb(580.4 * 1024 * 1024)).toBe('580 MB')
  })

  it('guards invalid input', () => {
    expect(formatAppMemoryMb(Number.NaN)).toBe('0 MB')
    expect(formatAppMemoryMb(-1)).toBe('0 MB')
  })
})
