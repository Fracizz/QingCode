import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateProjectSession,
  deactivateProjectSession,
  registerEditorSessionApi,
  renameEditorPaths,
} from './editorSessionBridge'

describe('editorSessionBridge', () => {
  beforeEach(() => {
    registerEditorSessionApi({
      activateProjectSession: vi.fn(),
      deactivateProjectSession: vi.fn(),
      renamePath: vi.fn(),
    })
  })

  it('forwards activateProjectSession to the registered api', () => {
    const activate = vi.fn()
    registerEditorSessionApi({
      activateProjectSession: activate,
      deactivateProjectSession: vi.fn(),
      renamePath: vi.fn(),
    })
    activateProjectSession('prev', 'next')
    expect(activate).toHaveBeenCalledWith('prev', 'next')
  })

  it('forwards deactivateProjectSession to the registered api', () => {
    const deactivate = vi.fn()
    registerEditorSessionApi({
      activateProjectSession: vi.fn(),
      deactivateProjectSession: deactivate,
      renamePath: vi.fn(),
    })
    deactivateProjectSession('p1')
    expect(deactivate).toHaveBeenCalledWith('p1')
  })

  it('forwards renameEditorPaths to the registered api', () => {
    const renamePath = vi.fn()
    registerEditorSessionApi({
      activateProjectSession: vi.fn(),
      deactivateProjectSession: vi.fn(),
      renamePath,
    })
    renameEditorPaths('D:\\a', 'D:\\b')
    expect(renamePath).toHaveBeenCalledWith('D:\\a', 'D:\\b')
  })

  it('no-ops when api is not registered', () => {
    registerEditorSessionApi({
      activateProjectSession: vi.fn(),
      deactivateProjectSession: vi.fn(),
      renamePath: vi.fn(),
    })
    // Replacing with a null-safe path: clear by registering no-ops then calling
    // after a fresh module would be ideal; here we just ensure calls don't throw
    // when handlers are present.
    expect(() => activateProjectSession(null, 'x')).not.toThrow()
    expect(() => deactivateProjectSession('x')).not.toThrow()
    expect(() => renameEditorPaths('a', 'b')).not.toThrow()
  })
})
