import { t } from '@qn/codex-client'
import type { MouseEvent } from 'react'
import { useImagePreview } from './ImagePreview'

export function MessageImage({ src, label, compact = false, inline = false }: {
  src: string
  label: string
  compact?: boolean
  inline?: boolean
}) {
  const preview = useImagePreview({ src, alt: label, label: t('{label}预览', { label }) })
  const trigger = {
    ref: preview.ref,
    type: 'button' as const,
    'aria-label': t('查看{label}', { label }),
    'aria-haspopup': 'dialog' as const,
    onClick: (event: MouseEvent<HTMLButtonElement>) => preview.open(event.currentTarget),
  }

  if (inline) return (
    <button {...trigger} className="max-w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-qn-outline-hover">
      <img src={src} alt={label} className="max-w-full" />
    </button>
  )
  if (compact) return (
    // 紧凑模式用于排队列表：缩略图配文字标签，单靠 24px 小图看不清是什么。
    <button {...trigger}
      className="inline-flex h-6 max-w-40 shrink-0 cursor-zoom-in items-center gap-1.5 rounded-md border border-qn-border-strong bg-qn-panel pl-0.5 pr-2 text-ui-sm text-qn-muted hover:bg-qn-hover hover:text-qn-text focus-visible:outline-2 focus-visible:outline-qn-outline-hover">
      <img src={src} alt="" className="size-5 shrink-0 rounded-sm bg-qn-bg object-cover" />
      <span className="truncate">{label}</span>
    </button>
  )
  return (
    <button {...trigger}
      className="max-w-[min(100%,16rem)] cursor-zoom-in overflow-hidden rounded-lg border border-qn-border bg-qn-panel text-qn-muted hover:text-qn-text focus-visible:outline-2 focus-visible:outline-qn-outline-hover focus-visible:outline-offset-2">
      <img src={src} alt="" className="mx-auto max-h-48 max-w-full object-contain" />
      <span className="block truncate px-2 py-1 text-ui-sm">{label}</span>
    </button>
  )
}
