import { useState, type ReactNode, type Ref, type RefObject } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { cn } from '../lib/cn'
import { IconButton } from './ui'

const ZOOM_LEVELS = [25, 50, 75, 100, 125, 150, 200, 300, 400]
const FIT_INDEX = ZOOM_LEVELS.indexOf(100)

export function ZoomableImage({ src, alt, className, imageRef, allowOriginalSize, onBlankClick, actions }: {
  src: string
  alt: string
  className?: string
  imageRef?: Ref<HTMLImageElement>
  allowOriginalSize?: boolean
  onBlankClick?: () => void
  actions?: ReactNode
}) {
  const [step, setStep] = useState(FIT_INDEX)
  const [originalSize, setOriginalSize] = useState(false)

  function reset(original: boolean) {
    setOriginalSize(original)
    setStep(FIT_INDEX)
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-2', className)}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <div role="group" aria-label="图片缩放" className="flex items-center gap-1 rounded-lg bg-qn-panel px-1">
          <IconButton label="缩小" tooltip={false} title="缩小" disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}>
            <Minus size={16} aria-hidden />
          </IconButton>
          <output className="min-w-10 text-center text-ui-sm text-qn-muted tabular-nums">{ZOOM_LEVELS[step]}%</output>
          <IconButton label="放大" tooltip={false} title="放大" disabled={step === ZOOM_LEVELS.length - 1}
            onClick={() => setStep((value) => Math.min(ZOOM_LEVELS.length - 1, value + 1))}>
            <Plus size={16} aria-hidden />
          </IconButton>
          <button type="button" className="qn-button-subtle h-8 whitespace-nowrap" onClick={() => reset(false)}>
            适应窗口
          </button>
          {allowOriginalSize && (
            <button type="button" className="qn-button-subtle h-8 whitespace-nowrap"
              aria-pressed={originalSize && step === FIT_INDEX} onClick={() => reset(true)}>
              原始尺寸
            </button>
          )}
        </div>
        {actions}
      </div>
      <div className="qn-scroll flex min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [container-type:size] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-qn-outline-hover"
        tabIndex={0} aria-label="图片查看区域" role="region" onClick={(event) => {
          if (event.target === event.currentTarget) onBlankClick?.()
        }}>
        {/* CSS zoom 参与布局，放大后可以滚动到图片的四条边。 */}
        <img ref={imageRef} src={src} alt={alt} loading="lazy" draggable={false}
          className={cn(
            'm-auto block h-auto w-auto shrink-0',
            originalSize ? 'max-h-none max-w-none' : 'max-h-[100cqh] max-w-[100cqw]',
            allowOriginalSize && (originalSize ? 'cursor-zoom-out' : 'cursor-zoom-in'),
          )}
          style={{ zoom: ZOOM_LEVELS[step]! / 100 }}
          onClick={allowOriginalSize ? () => reset(!originalSize) : undefined} />
      </div>
    </div>
  )
}

export function ImagePreviewDialog({ dialogRef, src, alt, label, imageRef, actions }: {
  dialogRef: RefObject<HTMLDialogElement | null>
  src: string
  alt: string
  label: string
  imageRef?: Ref<HTMLImageElement>
  actions?: ReactNode
}) {
  const [previewId, setPreviewId] = useState(0)
  const close = () => dialogRef.current?.close()
  return (
    <dialog ref={dialogRef} aria-label={label}
      className="qn-no-drag fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-3 backdrop:bg-qn-code/90 open:flex"
      onClose={() => setPreviewId((value) => value + 1)} onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}>
      <ZoomableImage key={previewId} src={src} alt={alt} imageRef={imageRef}
        onBlankClick={close}
        actions={<>
          {actions}
          <IconButton label="关闭图片预览" tooltip={false} className="bg-qn-panel text-qn-text" onClick={close}>
            <X size={16} aria-hidden />
          </IconButton>
        </>} />
    </dialog>
  )
}
