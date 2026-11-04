// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { scopedStorage, testSessionId } from './webTestStorage'

describe('Web test session isolation', () => {
  it('keeps app keys and resets isolated from other tests and the normal app', () => {
    const a = scopedStorage(localStorage, 'case-a:')
    const b = scopedStorage(localStorage, 'case-b:')
    localStorage.setItem('normal-setting', 'normal')
    a.setItem('project', 'a')
    b.setItem('project', 'b')
    expect(scopedStorage(localStorage, 'case-a:').getItem('project')).toBe('a')
    a.clear()
    expect(a.length).toBe(0)
    expect(b.getItem('project')).toBe('b')
    expect(localStorage.getItem('normal-setting')).toBe('normal')
    b.clear()
    localStorage.removeItem('normal-setting')
  })

  it('validates explicit session identifiers', () => {
    expect(testSessionId('')).toBe('manual')
    expect(testSessionId('?testSession=run-123')).toBe('run-123')
    expect(() => testSessionId('?testSession=../other')).toThrow('Invalid')
  })
})
