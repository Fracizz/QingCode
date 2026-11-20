// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { crossfadeRegion } from './layoutMotion'

function surface() {
  const element = document.createElement('div')
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
    playState: 'running',
    pending: false,
    cancel: vi.fn(),
  }))
  element.animate = animate as unknown as HTMLElement['animate']
  return { element, animate }
}

afterEach(() => {
  delete document.documentElement.dataset.motion
})

describe('terminal crossfade', () => {
  it('drops both animation layers from an interrupted switch before showing the next session', () => {
    const first = surface()
    const second = surface()
    const third = surface()
    const previous = crossfadeRegion(second.element, first.element)
    expect(first.animate.mock.calls[0][0]).toEqual([{ visibility: 'visible' }, { visibility: 'visible' }])
    expect(second.animate.mock.calls[0][1].duration).toBe(120)

    crossfadeRegion(third.element, second.element, previous)
    expect(first.animate.mock.results[0].value.cancel).toHaveBeenCalledOnce()
    expect(second.animate.mock.results[0].value.cancel).toHaveBeenCalledOnce()
    expect(second.animate.mock.calls[1][0]).toEqual([{ visibility: 'visible' }, { visibility: 'visible' }])
    expect(third.animate.mock.calls[0][1].duration).toBe(120)
  })

  it('continues from the current blend when reversing a switch', () => {
    const first = surface()
    const second = surface()
    const previous = crossfadeRegion(second.element, first.element)
    second.element.style.opacity = '0.25'

    crossfadeRegion(first.element, second.element, previous)
    expect(first.animate.mock.calls[1]).toEqual([
      [{ opacity: 0.75 }, { opacity: 1 }],
      { duration: 40, easing: expect.any(String) },
    ])
  })

  it('keeps text partially visible when a split pane switches without an outgoing layer', () => {
    const next = surface()
    crossfadeRegion(next.element)
    expect(next.animate.mock.calls[0]).toEqual([
      [{ opacity: 0.45 }, { opacity: 1 }],
      { duration: 120, easing: expect.any(String) },
    ])
  })

  it('clears an in-flight fade when the next switch uses reduced motion', () => {
    const first = surface()
    const second = surface()
    const previous = crossfadeRegion(second.element, first.element)
    document.documentElement.dataset.motion = 'reduce'

    expect(crossfadeRegion(first.element, second.element, previous)).toBeUndefined()
    expect(first.animate).toHaveBeenCalledOnce()
    expect(first.animate.mock.results[0].value.cancel).toHaveBeenCalledOnce()
    expect(second.animate.mock.results[0].value.cancel).toHaveBeenCalledOnce()
  })
})
