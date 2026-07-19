/** Normalize OSC window titles for tab labels (emoji prefix, mojibake, etc.). */
export function sanitizeOscTitle(title: string): string {
  let cleaned = title.trim()
  if (!cleaned) return cleaned

  cleaned = cleaned
    .replace(/^[\s\p{Extended_Pictographic}\p{So}\uFE0F\u200D]+/u, '')
    .trim()

  const mojibakePrefix = cleaned.match(
    /^[^\x20-\x7E\u4E00-\u9FFF]{1,12}\s+([\x20-\x7E\u4E00-\u9FFF].*)$/
  )
  if (mojibakePrefix?.[1]) return mojibakePrefix[1].trim()

  return cleaned
}

export type TerminalOscHandlers = {
  onTitle?: (title: string) => void
  /** Foreground command started (FinalTerm / VS Code shell integration). */
  onCommandStart?: () => void
  /** Foreground command finished or prompt returned. */
  onCommandEnd?: () => void
}

/**
 * Parse shell-integration markers.
 * - `133;C` / `633;C` → command executed
 * - `133;D` / `633;D` → command finished
 * - `133;A` / `633;A` → prompt start (treat as idle)
 */
export function parseShellIntegrationOsc(
  body: string,
): 'start' | 'end' | null {
  // body is everything after `OSC ` / `]` — e.g. `133;C` or `633;D;0`
  const match = /^(?:133|633);([A-Za-z])/.exec(body)
  if (!match) return null
  const code = match[1].toUpperCase()
  if (code === 'C') return 'start'
  if (code === 'D' || code === 'A') return 'end'
  return null
}

/** Strip OSC title / shell-integration sequences from PTY output. */
export class TerminalOscParser {
  private carry = ''
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })

  feed(data: Uint8Array, handlers?: TerminalOscHandlers): Uint8Array {
    const input = this.carry + this.decoder.decode(data, { stream: true })

    const output: string[] = []
    let index = 0

    while (index < input.length) {
      const start = input.indexOf('\x1b]', index)
      if (start === -1) {
        output.push(input.slice(index))
        index = input.length
        break
      }

      output.push(input.slice(index, start))

      const bellEnd = input.indexOf('\x07', start + 2)
      const stEnd = input.indexOf('\x1b\\', start + 2)
      let end = -1
      let endLength = 0

      if (bellEnd !== -1 && (stEnd === -1 || bellEnd < stEnd)) {
        end = bellEnd
        endLength = 1
      } else if (stEnd !== -1) {
        end = stEnd
        endLength = 2
      }

      if (end === -1) {
        this.carry = input.slice(start)
        return encodeOutput(output.join(''))
      }

      const sequence = input.slice(start, end + endLength)
      const bodyMatch =
        /^\x1b\]([\s\S]*)\x07$/.exec(sequence) ?? /^\x1b\]([\s\S]*)\x1b\\$/.exec(sequence)
      const body = bodyMatch?.[1] ?? ''

      const titleMatch = /^(?:0|1|2);([\s\S]*)$/.exec(body)
      if (titleMatch) {
        const title = titleMatch[1]?.trim()
        if (title) handlers?.onTitle?.(sanitizeOscTitle(title))
      } else {
        const marker = parseShellIntegrationOsc(body)
        if (marker === 'start') handlers?.onCommandStart?.()
        else if (marker === 'end') handlers?.onCommandEnd?.()
      }

      index = end + endLength
    }

    this.carry = ''
    return encodeOutput(output.join(''))
  }
}

function encodeOutput(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
