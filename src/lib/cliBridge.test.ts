import { describe, expect, it } from 'vitest'
import { parseOpenTarget } from './cliBridge'

describe('parseOpenTarget', () => {
  it('parses unix path with line and column', () => {
    expect(parseOpenTarget('/tmp/a.ts:10:2')).toEqual({
      path: '/tmp/a.ts',
      line: 10,
      column: 2,
    })
  })

  it('parses windows path with line', () => {
    expect(parseOpenTarget('D:\\Work\\a.ts:12')).toEqual({
      path: 'D:\\Work\\a.ts',
      line: 12,
      column: undefined,
    })
  })

  it('keeps plain path', () => {
    expect(parseOpenTarget('D:\\Work\\a.ts')).toEqual({ path: 'D:\\Work\\a.ts' })
  })
})
