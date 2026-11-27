import { useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { t } from '@qn/codex-client'
import { Tip } from '../../components/primitives'
import { IconButton } from '../../components/ui'
import { formatBytes, type ImageAttachment } from '../../lib/attachments'
import { cn } from '../../lib/cn'
import { copyImage } from './imageClipboard'

export function ImageAttachmentChip({
  item,
  problem,
  onRemove,
}: {
  item: ImageAttachment
  problem?: string | null
  onRemove: () => void
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
        'flex h-14 max-w-[min(100%,15rem)] items-center gap-1 rounded-lg border bg-qn-fg/[0.03] p-1',
        problem ? 'border-qn-danger/70' : 'border-qn-border',
      )}
    >
      <Tip label={`${item.name} · ${problem ?? formatBytes(item.size)}`}>
        <button
          type="button"
          aria-label={t('查看图片 {name}', { name: item.name })}
          aria-haspopup="dialog"
          className="flex min-w-0 cursor-zoom-in items-center gap-2 rounded-md text-left text-ui text-qn-accent focus-visible:outline-2 focus-visible:outline-qn-accent"
          onClick={() => {
            setCopyState((state) => state === 'copying' ? state : 'idle')
            previewRef.current?.showModal()
          }}
        >
          <img src={item.dataUrl} alt="" className="size-11 shrink-0 rounded-md bg-qn-bg object-contain" />
          <span className="truncate underline underline-offset-2">{item.name}</span>
        </button>
      </Tip>
      <IconButton label={t('移除 {name}', { name: item.name })} size="sm" onClick={onRemove}>
        <X size={12} />
      </IconButton>
      <dialog
        ref={previewRef}
        aria-label={t('图片预览 {name}', { name: item.name })}
        className="qn-no-drag fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none place-items-center bg-transparent p-0 backdrop:bg-black/80 open:grid"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
      >
        <div className="absolute right-3 top-3 flex items-center gap-2">
          <button
            type="button"
            aria-label={t('复制图片')}
            disabled={copyState === 'copying'}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-qn-panel px-2.5 text-ui text-qn-text outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent"
            onClick={() => void copyPreview()}
          >
            {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            {copyLabel}
          </button>
          <span className="sr-only" role="status">{copyState === 'idle' ? '' : copyLabel}</span>
          <IconButton
            label={t('关闭图片预览')}
            className="bg-qn-panel text-qn-text"
            tooltip={false}
            onClick={() => previewRef.current?.close()}
          >
            <X size={16} />
          </IconButton>
        </div>
        <img
          ref={imageRef}
          src={item.dataUrl}
          alt={item.name}
          loading="lazy"
          className="h-auto w-auto max-h-[min(82dvh,calc(100dvh-6rem))] max-w-[min(88dvw,90rem)] object-contain"
        />
      </dialog>
    </div>
  )
}
