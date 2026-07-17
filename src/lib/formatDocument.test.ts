import { describe, expect, it } from 'vitest'
import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'

describe('formatDocument size gate', () => {
  it('aligns soft format cap with degraded-edit band (5 MB)', () => {
    expect(EDIT_DEGRADED_BYTES).toBe(5 * 1024 * 1024)
  })
})
