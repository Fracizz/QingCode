import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('忽略假值并拼接', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })

  it('后写的冲突类覆盖前者', () => {
    expect(cn('px-2 text-qn-muted', 'px-4')).toBe('text-qn-muted px-4')
  })

  it('界面字号 token 与文字颜色互不覆盖，字号之间后者生效', () => {
    expect(cn('text-ui-sm text-qn-muted')).toBe('text-ui-sm text-qn-muted')
    expect(cn('text-ui-sm', 'text-ui')).toBe('text-ui')
    expect(cn('text-ui-xs', 'text-[28px]')).toBe('text-[28px]')
  })

  it('支持对象写法', () => {
    expect(cn('rounded', { 'bg-qn-hover': true, hidden: false })).toBe('rounded bg-qn-hover')
  })
})
