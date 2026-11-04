/** Decode PTY bytes from a Tauri `terminal-data` payload. */
export function decodeTerminalEventData(data: unknown): Uint8Array | null {
  if (typeof data === 'string') {
    try {
      const binary = atob(data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    } catch {
      return null
    }
  }
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(data)
  return null
}
