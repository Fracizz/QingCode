import { useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import {
  annotationExcerpt,
  annotationLabel,
  quoteBlock,
  type Annotation,
} from '../lib/annotations'
import { IconButton } from './ui'

export function AnnotationBar({
  annotations,
  onRemove,
  contentWidthClassName,
}: {
  annotations: Annotation[]
  onRemove: (id: string) => void
  contentWidthClassName: string
}) {
  const [open, setOpen] = useState(false)
  if (annotations.length === 0) return null

  return (
    <div className="px-6 pt-1">
      <div className={`mx-auto rounded-xl border border-qn-border bg-qn-panel text-ui-sm ${contentWidthClassName}`}>
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-8 w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-xl px-3 py-1 text-left text-qn-accent hover:bg-qn-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-qn-accent"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            {annotationLabel(annotations.length)}
          </span>
          <span className="text-qn-muted">随下一条消息发送</span>
        </button>
        {open && (
          <div className="qn-scroll max-h-40 space-y-2 overflow-y-auto px-3 pb-2 pt-1">
            {annotations.map((annotation) => (
              <div key={annotation.id} className="flex items-start gap-2 rounded-lg border border-qn-border bg-qn-inset p-2">
                <div className="min-w-0 flex-1 wrap-anywhere">
                  <div className="whitespace-pre-wrap font-mono text-ui-sm leading-4 text-qn-muted">
                    {quoteBlock(annotationExcerpt(annotation, 200))}
                  </div>
                  {annotation.comment && (
                    <div className="mt-1 text-ui-sm">{annotation.comment}</div>
                  )}
                </div>
                <IconButton label="删除注释" size="sm" danger onClick={() => onRemove(annotation.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
