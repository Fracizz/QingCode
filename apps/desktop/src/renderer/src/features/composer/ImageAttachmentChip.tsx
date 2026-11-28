import { X } from 'lucide-react'
import { t } from '@qn/codex-client'
import { useImagePreview } from '../../components/ImagePreview'
import { Tip } from '../../components/primitives'
import { IconButton } from '../../components/ui'
import { formatBytes, type ImageAttachment } from '../../lib/attachments'
import { cn } from '../../lib/cn'

export function ImageAttachmentChip({
  item,
  problem,
  onRemove,
  previewButtonRef,
}: {
  item: ImageAttachment
  problem?: string | null
  onRemove: () => void
  previewButtonRef?: (button: HTMLButtonElement | null) => void
}) {
  const preview = useImagePreview({ src: item.dataUrl, alt: item.name,
    label: t('图片预览 {name}', { name: item.name }) }, previewButtonRef)

  return (
    <div
      className={cn(
        'relative inline-flex shrink-0 rounded-lg border bg-qn-fg/[0.03] p-1.5',
        problem ? 'border-qn-border-strong' : 'border-qn-border',
      )}
    >
      <Tip label={`${item.name} · ${problem ?? formatBytes(item.size)}`}>
        <button
          ref={preview.ref}
          type="button"
          aria-label={t('查看图片 {name}', { name: item.name })}
          aria-haspopup="dialog"
          className="block cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-qn-outline-hover"
          onClick={(event) => preview.open(event.currentTarget)}
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
    </div>
  )
}
