import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampScmFilesWidth,
  clampScmLeftWidth,
  loadScmLayout,
  saveScmLayout,
  SCM_FILES_DEFAULT,
  SCM_FILES_MAX,
  SCM_FILES_MIN,
  SCM_LAYOUT_KEY,
  SCM_LAYOUT_VERSION,
  SCM_LEFT_DEFAULT,
  SCM_LEFT_MAX,
  SCM_LEFT_MIN,
} from './scmLayout'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scmLayout', () => {
  it('clamps left and files widths to min/max', () => {
    expect(clampScmLeftWidth(0)).toBe(SCM_LEFT_MIN)
    expect(clampScmLeftWidth(9999)).toBe(SCM_LEFT_MAX)
    expect(clampScmFilesWidth(0)).toBe(SCM_FILES_MIN)
    expect(clampScmFilesWidth(9999)).toBe(SCM_FILES_MAX)
  })

  it('respects remaining space inside a container', () => {
    expect(clampScmLeftWidth(500, 500)).toBeLessThanOrEqual(500 - 280)
    expect(clampScmFilesWidth(800, 800)).toBeLessThanOrEqual(800 - 360)
  })

  it('loads defaults and persists layout', () => {
    expect(loadScmLayout()).toEqual({
      version: SCM_LAYOUT_VERSION,
      leftWidth: SCM_LEFT_DEFAULT,
      filesWidth: SCM_FILES_DEFAULT,
    })
    saveScmLayout({ leftWidth: 400, filesWidth: 360 })
    expect(loadScmLayout()).toEqual({
      version: SCM_LAYOUT_VERSION,
      leftWidth: 400,
      filesWidth: 360,
    })
    expect(store.get(SCM_LAYOUT_KEY)).toContain('"leftWidth":400')
    expect(store.get(SCM_LAYOUT_KEY)).toContain(`"version":${SCM_LAYOUT_VERSION}`)
  })

  it('upgrades legacy layouts to the history ~2/5 detail default', () => {
    store.set(SCM_LAYOUT_KEY, JSON.stringify({ leftWidth: 340, filesWidth: 240 }))
    expect(loadScmLayout()).toEqual({
      version: SCM_LAYOUT_VERSION,
      leftWidth: 340,
      filesWidth: SCM_FILES_DEFAULT,
    })
  })
})
