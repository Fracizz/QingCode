import { getChunks } from '@codemirror/merge'
import { RangeSet, RangeSetBuilder, type Extension } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'

class DiffSignMarker extends GutterMarker {
  constructor(
    readonly sign: string,
    readonly tone: 'minus' | 'plus'
  ) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffSignMarker && other.sign === this.sign
  }

  toDOM() {
    const span = document.createElement('span')
    span.textContent = this.sign
    span.className = `qc-diff-sign qc-diff-sign-${this.tone}`
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}

const minusMarker = new DiffSignMarker('−', 'minus')
const plusMarker = new DiffSignMarker('+', 'plus')

function lineStartsInRange(doc: EditorView['state']['doc'], from: number, to: number): number[] {
  if (from >= to) return []
  const starts: number[] = []
  let line = doc.lineAt(from)
  const endLine = doc.lineAt(Math.min(Math.max(from, to - 1), doc.length))
  while (true) {
    starts.push(line.from)
    if (line.number >= endLine.number) break
    line = doc.lineAt(line.to + 1)
  }
  return starts
}

function signMarkers(view: EditorView, side: 'a' | 'b'): RangeSet<GutterMarker> {
  const info = getChunks(view.state)
  if (!info || info.side !== side) return RangeSet.empty
  const marker = side === 'a' ? minusMarker : plusMarker
  const builder = new RangeSetBuilder<GutterMarker>()
  const seen = new Set<number>()
  for (const chunk of info.chunks) {
    const from = side === 'a' ? chunk.fromA : chunk.fromB
    const to = side === 'a' ? chunk.toA : chunk.toB
    if (from >= to) continue
    for (const lineStart of lineStartsInRange(view.state.doc, from, to)) {
      if (seen.has(lineStart)) continue
      seen.add(lineStart)
      builder.add(lineStart, lineStart, marker)
    }
  }
  return builder.finish()
}

/** Git-style − / + column; use with MergeView `gutter: false`. */
export function mergeDiffSignGutter(side: 'a' | 'b'): Extension {
  return gutter({
    class: 'cm-diffSignGutter',
    markers: view => signMarkers(view, side),
  })
}
