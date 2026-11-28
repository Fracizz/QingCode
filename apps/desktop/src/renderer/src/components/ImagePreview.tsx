import { t } from '@qn/codex-client'
import { Check, ChevronLeft, ChevronRight, Copy, X } from 'lucide-react'
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { copyImage } from '../features/composer/imageClipboard'
import { IconButton } from './ui'
import { ZoomableImage } from './ZoomableImage'

type PreviewImage = { src: string; alt: string; label: string }
type ImageButtonRef = (button: HTMLButtonElement | null) => void

const PreviewGroup = createContext<{
  thumbnails: Map<HTMLButtonElement, PreviewImage>
  open: (button: HTMLButtonElement) => void
} | null>(null)

export function ImagePreviewGroup({ children, copyable }: { children: ReactNode; copyable?: boolean }) {
  const [preview, setPreview] = useState<{ images: PreviewImage[]; index: number } | null>(null)
  const [group] = useState(() => {
    const thumbnails = new Map<HTMLButtonElement, PreviewImage>()
    return { thumbnails, open: (button: HTMLButtonElement) => {
      // 缩略图可能随流式 Markdown 更新重新挂载，以页面上的顺序为准。
      const entries = [...thumbnails].sort(([left], [right]) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      const index = entries.findIndex(([thumbnail]) => thumbnail === button)
      if (index >= 0) setPreview({ images: entries.map(([, image]) => image), index })
    } }
  })

  return (
    <PreviewGroup.Provider value={group}>
      {children}
      {preview && <ImagePreviewDialog {...preview} copyable={copyable} onClose={() => setPreview(null)}
        onStep={(direction) => setPreview((current) => {
          if (!current) return current
          const index = current.index + direction
          return index >= 0 && index < current.images.length ? { ...current, index } : current
        })} />}
    </PreviewGroup.Provider>
  )
}

export function useImagePreview(image: PreviewImage, buttonRef?: ImageButtonRef) {
  const group = useContext(PreviewGroup)
  if (!group) throw new Error('Image previews require an ImagePreviewGroup')
  return {
    ref: (button: HTMLButtonElement | null) => {
      if (!button) return
      group.thumbnails.set(button, image)
      buttonRef?.(button)
      return () => {
        group.thumbnails.delete(button)
        buttonRef?.(null)
      }
    },
    open: group.open,
  }
}

function ImagePreviewDialog({ images, index, copyable, onClose, onStep }: {
  images: PreviewImage[]
  index: number
  copyable?: boolean
  onClose: () => void
  onStep: (direction: -1 | 1) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const navigation = useRef<HTMLDivElement>(null)
  const previousButton = useRef<HTMLButtonElement>(null)
  const nextButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<RefObject<HTMLElement | null> | null>(null)
  const image = images[index]!
  const multiple = images.length > 1
  useLayoutEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])
  useLayoutEffect(() => {
    restoreFocus.current?.current?.focus({ preventScroll: true })
    restoreFocus.current = null
  }, [index])

  const step = (direction: -1 | 1) => {
    if (index + direction < 0 || index + direction >= images.length) return
    // 翻页重置缩放和滚动，保留翻页控件的焦点以便连续操作。
    const active = document.activeElement
    restoreFocus.current = active === previousButton.current ? previousButton
      : active === nextButton.current ? nextButton : navigation
    onStep(direction)
  }

  return (
    <dialog ref={dialogRef} aria-label={image.label}
      className="qn-no-drag fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-3 backdrop:bg-qn-code/90 open:flex"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={(event) => {
        if (!multiple || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
            (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        event.preventDefault()
        event.stopPropagation()
        step(event.key === 'ArrowLeft' ? -1 : 1)
      }}>
      <ZoomableImage key={index} src={image.src} alt={image.alt} imageRef={imageRef} onBlankClick={onClose}
        actions={<>
          {multiple && (
            <div ref={navigation} tabIndex={-1} role="group" aria-label={t('切换图片')}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-qn-border bg-qn-panel px-1 shadow-lg">
              <IconButton ref={previousButton} label={t('上一张图片')} tooltip={false} aria-disabled={index === 0}
                className="aria-disabled:opacity-40" onClick={() => step(-1)}>
                <ChevronLeft size={18} aria-hidden />
              </IconButton>
              <output aria-label={t('图片位置')} className="min-w-10 text-center text-ui-sm text-qn-muted tabular-nums">
                {index + 1} / {images.length}
              </output>
              <IconButton ref={nextButton} label={t('下一张图片')} tooltip={false} aria-disabled={index === images.length - 1}
                className="aria-disabled:opacity-40" onClick={() => step(1)}>
                <ChevronRight size={18} aria-hidden />
              </IconButton>
            </div>
          )}
          {copyable && <CopyPreviewButton imageRef={imageRef} />}
          <IconButton label={t('关闭图片预览')} tooltip={false} className="bg-qn-panel text-qn-text" onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        </>} />
    </dialog>
  )
}

function CopyPreviewButton({ imageRef }: { imageRef: RefObject<HTMLImageElement | null> }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const label = {
    idle: t('复制图片'),
    copying: t('复制中…'),
    copied: t('已复制图片'),
    error: t('复制失败，重试'),
  }[state]
  const copy = async () => {
    if (!imageRef.current || state === 'copying') return
    setState('copying')
    setState(await copyImage(imageRef.current) ? 'copied' : 'error')
  }
  return (
    <>
      <button type="button" aria-label={t('复制图片')} disabled={state === 'copying'} onClick={() => void copy()}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-qn-panel px-2.5 text-ui text-qn-text outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-outline-hover">
        {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        {label}
      </button>
      <span className="sr-only" role="status">{state === 'idle' ? '' : label}</span>
    </>
  )
}
