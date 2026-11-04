import { describe, expect, it } from 'vitest'
import { decodeTerminalEventData } from './terminalIpc'

describe('decodeTerminalEventData', () => {
  it('decodes base64 payloads used by the native PTY emitter', () => {
    const bytes = decodeTerminalEventData(btoa('hello'))
    expect(bytes).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
  })

  it('accepts a number array for older event payloads', () => {
    expect(decodeTerminalEventData([0, 1, 255])).toEqual(new Uint8Array([0, 1, 255]))
  })

  it('returns null for invalid base64', () => {
    expect(decodeTerminalEventData('*')).toBeNull()
  })
})
