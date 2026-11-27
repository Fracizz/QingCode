import type { TermAttachResult, TermInfo, TermOutputChunk } from '@qn/protocol'
import { normalizePath } from '../files/fileLinks'

function terminalPathKey(path: string, windows: boolean): string {
  if (windows) return normalizePath(path, 'windows').replace(/\\/g, '/').toLowerCase()
  // POSIX 路径中的反斜杠是普通字符，不参与目录划分。
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}

export function restoreTerminalTabs(terminals: TermInfo[], cwd: string, activeId: string | null) {
  const tabs = terminals.filter((terminal) => {
    const windows = terminal.backend === 'conpty'
    return terminalPathKey(terminal.cwd, windows) === terminalPathKey(cwd, windows)
  })
    .sort((left, right) => left.startedAt - right.startedAt)
  const active = tabs.find((terminal) => terminal.termId === activeId)
    ?? tabs.find((terminal) => terminal.alive)
    ?? tabs[0]
  return { tabs, activeId: active?.termId ?? null }
}

export function planTerminalReplay(
  sinceSeq: number,
  replay: Pick<TermAttachResult, 'mode' | 'chunks' | 'lastSeq' | 'snapshot'>,
  live: TermOutputChunk[],
) {
  const snapshot = replay.mode === 'snapshot' ? replay.snapshot : undefined
  const reset = replay.mode !== 'replay'
  const historyLost = reset && !snapshot
  const baseSeq = snapshot?.seq ?? (reset ? (replay.chunks[0]?.seq ?? replay.lastSeq + 1) - 1 : sinceSeq)
  const chunks = new Map<number, TermOutputChunk>()
  // 实时事件可能已经在途，回放和实时流在接回时会覆盖部分相同 seq。
  for (const chunk of [...live, ...replay.chunks]) {
    if (chunk.seq > baseSeq) chunks.set(chunk.seq, chunk)
  }
  const ordered = [...chunks.values()].sort((left, right) => left.seq - right.seq)
  return { reset, historyLost, baseSeq, snapshot, chunks: ordered }
}
