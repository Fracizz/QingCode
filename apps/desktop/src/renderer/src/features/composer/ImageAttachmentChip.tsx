import { useRef, useState, type Ref } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { t } from '@qn/codex-client'
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
    idle: t('复制图片'),
    copying: t('复制中…'),
    copied: t('已复制图片'),
    error: t('复制失败，重试'),
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
          aria-label={t('查看图片 {name}', { name: item.name })}
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
        label={t('移除 {name}', { name: item.name })}
        size="sm"
        className="absolute -right-1.5 -top-1.5 size-5 border border-qn-border-strong bg-qn-panel"
        onClick={onRemove}
      >
        <X size={12} />
      </IconButton>
      <ImagePreviewDialog dialogRef={previewRef} src={item.dataUrl} alt={item.name}
        label={t('图片预览 {name}', { name: item.name })} imageRef={imageRef} actions={<>
          <button
            type="button"
            aria-label={t('复制图片')}
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
