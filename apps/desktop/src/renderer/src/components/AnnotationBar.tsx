import { useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import {
  annotationExcerpt,
  annotationLabel,
  quoteBlock,
  type Annotation,
} from '../lib/annotations'

export function AnnotationBar({
  annotations,
  onRemove,
}: {
  annotations: Annotation[]
  onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (annotations.length === 0) return null

  return (
    <div className="shrink-0 border-t border-qn-border bg-qn-panel px-4 pt-2 text-xs">
      <button
        type="button"
        className="flex items-center gap-1 text-qn-accent hover:underline"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {annotationLabel(annotations.length)}
        <span className="text-qn-muted">随下一条消息发送</span>
      </button>
      {open && (
        <div className="qn-scroll mt-2 max-h-40 space-y-2 overflow-y-auto pb-2">
          {annotations.map((annotation) => (
            <div key={annotation.id} className="rounded border border-qn-border bg-black/20 p-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-qn-muted">
                    {quoteBlock(annotationExcerpt(annotation, 200))}
                  </div>
                  {annotation.comment && (
                    <div className="mt-1 break-words text-[11px]">{annotation.comment}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-qn-muted hover:bg-white/10 hover:text-qn-danger"
                  title="删除注释"
                  aria-label="删除注释"
                  onClick={() => onRemove(annotation.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
