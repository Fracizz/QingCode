// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { lockTerminalHostScroll } from './terminalHostScrollLock'

describe('lockTerminalHostScroll', () => {
  it('宿主容器被浏览器滚动后立即归零，解除后不再干预', () => {
    const host = document.createElement('div')
    const dispose = lockTerminalHostScroll([host, null])

    host.scrollTop = 48
    host.scrollLeft = 12
    host.dispatchEvent(new Event('scroll'))
    expect(host.scrollTop).toBe(0)
    expect(host.scrollLeft).toBe(0)

    dispose()
    host.scrollTop = 48
    host.dispatchEvent(new Event('scroll'))
    expect(host.scrollTop).toBe(48)
  })
})
