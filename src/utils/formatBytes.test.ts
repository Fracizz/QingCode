import { describe, expect, it } from 'vitest'
import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it('shows bytes below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(800)).toBe('800 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('shows KB below 1 MB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(1024 * 1024 - 1)).toMatch(/ KB$/)
  })

  it('shows MB with two decimals at 1 MB and above', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.50 MB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.00 MB')
  })

  it('shows GB / TB with two decimals', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB')
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB')
  })

  it('rejects invalid input as 0 B', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-10)).toBe('0 B')
  })
})
