import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deferToNativeContextMenuInDev,
  setNativeContextMenuPreferredInDev,
  shouldShowAppContextMenu,
} from './devBuild'

afterEach(() => {
  setNativeContextMenuPreferredInDev(false)
})

describe('deferToNativeContextMenuInDev', () => {
  it('defers only after devtools toggle in dev builds', () => {
    expect(deferToNativeContextMenuInDev()).toBe(false)
    setNativeContextMenuPreferredInDev(true)
    expect(deferToNativeContextMenuInDev()).toBe(import.meta.env.DEV)
  })
})

describe('shouldShowAppContextMenu', () => {
  it('shows app menu by default; defers when native mode is toggled in dev', () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    expect(shouldShowAppContextMenu({ preventDefault, stopPropagation })).toBe(true)
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()

    preventDefault.mockClear()
    stopPropagation.mockClear()
    setNativeContextMenuPreferredInDev(true)

    if (import.meta.env.DEV) {
      expect(shouldShowAppContextMenu({ preventDefault, stopPropagation })).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
    } else {
      expect(shouldShowAppContextMenu({ preventDefault, stopPropagation })).toBe(true)
    }
  })
})
