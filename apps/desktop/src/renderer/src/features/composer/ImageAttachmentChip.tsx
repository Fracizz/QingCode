import { useRef, useState, type Ref } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Tip } from '../../components/primitives'
import { IconButton } from '../../components/ui'
import { ImagePreviewDialog } from '../../components/ZoomableImage'
import { formatBytes, type ImageAttachment } from '../../lib/attachments'
import { cn } from '../../lib/cn'
import { copyImage } from './imageClipboard'

export function ImageAttachmentChip({
  item,
  problem,
  onRemove,
  previewButtonRef,
}: {
  item: ImageAttachment
  problem?: string | null
  onRemove: () => void
  previewButtonRef?: Ref<HTMLButtonElement>
}) {
  const previewRef = useRef<HTMLDialogElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const copyLabel = {
    idle: '复制图片',
    copying: '复制中…',
    copied: '已复制图片',
    error: '复制失败，重试',
  }[copyState]

  const copyPreview = async () => {
    if (!imageRef.current || copyState === 'copying') return
    setCopyState('copying')
    setCopyState((await copyImage(imageRef.current)) ? 'copied' : 'error')
  }

  return (
    <div
      className={cn(
        'relative inline-flex shrink-0 rounded-lg border bg-qn-fg/[0.03] p-1.5',
        problem ? 'border-qn-border-strong' : 'border-qn-border',
      )}
    >
      <Tip label={`${item.name} · ${problem ?? formatBytes(item.size)}`}>
        <button
          ref={previewButtonRef}
          type="button"
          aria-label={`查看图片 ${item.name}`}
          aria-haspopup="dialog"
          className="block cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-qn-outline-hover"
          onClick={() => {
            setCopyState((state) => state === 'copying' ? state : 'idle')
            previewRef.current?.showModal()
          }}
        >
          <img src={item.dataUrl} alt="" className="size-11 shrink-0 rounded-md bg-qn-bg object-contain" />
        </button>
      </Tip>
      <IconButton
        label={`移除 ${item.name}`}
        size="sm"
        className="absolute -right-1.5 -top-1.5 size-5 border border-qn-border-strong bg-qn-panel"
        onClick={onRemove}
      >
        <X size={12} />
      </IconButton>
      <ImagePreviewDialog dialogRef={previewRef} src={item.dataUrl} alt={item.name}
        label={`图片预览 ${item.name}`} imageRef={imageRef} actions={<>
          <button
            type="button"
            aria-label="复制图片"
            disabled={copyState === 'copying'}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-qn-panel px-2.5 text-ui text-qn-text outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-outline-hover"
            onClick={() => void copyPreview()}
          >
            {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            {copyLabel}
          </button>
          <span className="sr-only" role="status">{copyState === 'idle' ? '' : copyLabel}</span>
        </>} />
    </div>
  )
}
