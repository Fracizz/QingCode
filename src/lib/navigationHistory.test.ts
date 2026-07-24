import { describe, expect, it } from 'vitest'
import {
  EMPTY_NAVIGATION_HISTORY,
  canNavigateBack,
  canNavigateForward,
  locationsEqual,
  navigateBack,
  navigateForward,
  pushNavigation,
  type EditorLocation,
} from './navigationHistory'

const loc = (path: string, line: number, column = 1): EditorLocation => ({
  path,
  line,
  column,
})

describe('locationsEqual', () => {
  it('compares path case-insensitively with normalized separators', () => {
    expect(locationsEqual(loc('D:\\a\\b.ts', 2, 3), loc('d:/a/b.ts', 2, 3))).toBe(true)
    expect(locationsEqual(loc('D:/a/b.ts', 2, 3), loc('D:/a/b.ts', 2, 4))).toBe(false)
  })
})

describe('pushNavigation', () => {
  it('pushes current and clears forward', () => {
    const withForward = {
      back: [loc('a.ts', 1)],
      forward: [loc('c.ts', 3)],
    }
    const next = pushNavigation(withForward, loc('b.ts', 2), loc('d.ts', 4))
    expect(next.back).toEqual([loc('a.ts', 1), loc('b.ts', 2)])
    expect(next.forward).toEqual([])
  })

  it('coalesces identical consecutive current locations', () => {
    const state = pushNavigation(EMPTY_NAVIGATION_HISTORY, loc('a.ts', 1), loc('b.ts', 2))
    const again = pushNavigation(state, loc('a.ts', 1), loc('c.ts', 3))
    expect(again.back).toEqual([loc('a.ts', 1)])
    expect(again.forward).toEqual([])
  })

  it('skips when current equals next', () => {
    const state = pushNavigation(EMPTY_NAVIGATION_HISTORY, loc('a.ts', 1), loc('a.ts', 1))
    expect(state).toBe(EMPTY_NAVIGATION_HISTORY)
  })
})

describe('navigateBack / navigateForward', () => {
  it('walks back and forward like a browser history stack', () => {
    let state = EMPTY_NAVIGATION_HISTORY
    state = pushNavigation(state, loc('a.ts', 1), loc('b.ts', 2))
    state = pushNavigation(state, loc('b.ts', 2), loc('c.ts', 3))

    const back1 = navigateBack(state, loc('c.ts', 3))
    expect(back1?.target).toEqual(loc('b.ts', 2))
    state = back1!.state
    expect(canNavigateBack(state)).toBe(true)
    expect(canNavigateForward(state)).toBe(true)

    const back2 = navigateBack(state, loc('b.ts', 2))
    expect(back2?.target).toEqual(loc('a.ts', 1))
    state = back2!.state
    expect(canNavigateBack(state)).toBe(false)

    const forward1 = navigateForward(state, loc('a.ts', 1))
    expect(forward1?.target).toEqual(loc('b.ts', 2))
    state = forward1!.state

    const forward2 = navigateForward(state, loc('b.ts', 2))
    expect(forward2?.target).toEqual(loc('c.ts', 3))
    expect(canNavigateForward(forward2!.state)).toBe(false)
  })

  it('returns null on empty stacks', () => {
    expect(navigateBack(EMPTY_NAVIGATION_HISTORY, loc('a.ts', 1))).toBeNull()
    expect(navigateForward(EMPTY_NAVIGATION_HISTORY, loc('a.ts', 1))).toBeNull()
  })
})
