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

/** Strip OSC title sequences from PTY output and surface titles for tab renaming. */
export class TerminalOscParser {
  private carry = ''
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })

  feed(data: Uint8Array, onTitle?: (title: string) => void): Uint8Array {
    let input = this.carry + this.decoder.decode(data, { stream: true })

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
      const match =
        /^\x1b\]([012]);([\s\S]*)\x07$/.exec(sequence) ??
        /^\x1b\]([012]);([\s\S]*)\x1b\\$/.exec(sequence)
      const title = match?.[2]?.trim()
      if (title) onTitle?.(sanitizeOscTitle(title))

      index = end + endLength
    }

    this.carry = ''
    return encodeOutput(output.join(''))
  }
}

function encodeOutput(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
