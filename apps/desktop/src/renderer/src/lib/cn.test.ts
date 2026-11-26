import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('忽略假值并拼接', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })

  it('后写的冲突类覆盖前者', () => {
    expect(cn('px-2 text-qn-muted', 'px-4')).toBe('text-qn-muted px-4')
  })

  it('支持对象写法', () => {
    expect(cn('rounded', { 'bg-qn-hover': true, hidden: false })).toBe('rounded bg-qn-hover')
  })
})
