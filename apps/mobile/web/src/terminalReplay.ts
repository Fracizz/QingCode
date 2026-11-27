import type { TermAttachResult, TermOutputChunk } from '@qn/protocol'

export function planMobileTerminalReplay(
  sinceSeq: number,
  replay: Pick<TermAttachResult, 'mode' | 'chunks' | 'lastSeq' | 'snapshot'>,
  pending: TermOutputChunk[],
) {
  const snapshot = replay.mode === 'snapshot' ? replay.snapshot : undefined
  const reset = replay.mode !== 'replay'
  const baseSeq = snapshot?.seq ?? (reset ? (replay.chunks[0]?.seq ?? replay.lastSeq + 1) - 1 : sinceSeq)
  const ordered = new Map<number, TermOutputChunk>()
  for (const chunk of [...pending, ...replay.chunks]) {
    if (chunk.seq > baseSeq) ordered.set(chunk.seq, chunk)
  }
  const sequence = [...ordered.values()].sort((a, b) => a.seq - b.seq)
  let offset = 0
  while (offset < sequence.length && sequence[offset]?.seq === baseSeq + offset + 1) offset++
  return {
    baseSeq, reset, snapshot,
    historyLost: reset && !snapshot,
    gap: offset !== sequence.length || baseSeq + offset < replay.lastSeq,
    chunks: sequence.slice(0, offset),
  }
}

export function encodeTerminalInput(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let index = 0; index < bytes.length; index += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
  }
  return btoa(parts.join(''))
}

export function decodeTerminalOutput(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
