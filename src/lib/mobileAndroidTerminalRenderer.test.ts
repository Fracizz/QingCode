import { describe, expect, it, vi } from 'vitest'
import { attachTerminalRenderer } from '../../mobile/android/web/terminalRenderer.js'

function fixture({ throwOnLoad = false } = {}) {
  const addons: FakeAddon[] = []
  class FakeAddon {
    lost?: () => void
    disposed = false
    constructor() {
      addons.push(this)
    }
    onContextLoss(listener: () => void) {
      this.lost = listener
    }
    dispose() {
      this.disposed = true
    }
  }
  const term = {
    rows: 24,
    refresh: vi.fn(),
    loadAddon: vi.fn(() => {
      if (throwOnLoad) throw new Error('WebGL2 not supported')
    }),
  }
  return { addons, term, Addon: FakeAddon }
}

describe('Android terminal renderer', () => {
  it('uses WebGL when enabled and stays on DOM when disabled', () => {
    const on = fixture()
    expect(attachTerminalRenderer(on.term, { Addon: on.Addon, enabled: () => true }).active()).toBe(true)
    const off = fixture()
    expect(attachTerminalRenderer(off.term, { Addon: off.Addon, enabled: () => false }).active()).toBe(false)
    expect(off.term.loadAddon).not.toHaveBeenCalled()
    expect(attachTerminalRenderer(off.term, { Addon: undefined, enabled: () => true }).active()).toBe(false)
  })

  it('falls back to DOM without WebGL2 and does not retry', () => {
    const { term, Addon } = fixture({ throwOnLoad: true })
    const renderer = attachTerminalRenderer(term, { Addon, enabled: () => true })
    expect(renderer.active()).toBe(false)
    renderer.wake()
    expect(term.loadAddon).toHaveBeenCalledTimes(1)
  })

  it('repaints on context loss, restores on wake and gives up after repeated losses', () => {
    const { addons, term, Addon } = fixture()
    const renderer = attachTerminalRenderer(term, { Addon, enabled: () => true })
    for (let loss = 0; loss < 3; loss += 1) {
      addons[loss].lost?.()
      expect(addons[loss].disposed).toBe(true)
      expect(renderer.active()).toBe(false)
      expect(term.refresh).toHaveBeenLastCalledWith(0, 23)
      renderer.wake()
    }
    expect(addons).toHaveLength(3)
    expect(renderer.active()).toBe(false)
  })

  it('switches live with the setting and allows WebGL again after re-enabling', () => {
    const { addons, term, Addon } = fixture()
    let enabled = true
    const renderer = attachTerminalRenderer(term, { Addon, enabled: () => enabled })
    enabled = false
    renderer.sync()
    expect(addons[0].disposed).toBe(true)
    expect(renderer.active()).toBe(false)
    enabled = true
    renderer.sync()
    expect(renderer.active()).toBe(true)
  })

  it('ignores calls after disposal', () => {
    const { addons, term, Addon } = fixture()
    const renderer = attachTerminalRenderer(term, { Addon, enabled: () => true })
    renderer.dispose()
    renderer.wake()
    renderer.sync()
    expect(addons).toHaveLength(1)
    expect(addons[0].disposed).toBe(true)
  })
})
