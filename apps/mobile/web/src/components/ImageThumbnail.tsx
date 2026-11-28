import { t } from '@qn/codex-client'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Button, Dialog } from './ui'
import { ZoomableImage } from './ZoomableImage'

type PreviewImage = {
  src: string
  alt: string
  externalHref?: string
}

const PreviewGroup = createContext<{
  thumbnails: Map<HTMLButtonElement, PreviewImage>
  open: (button: HTMLButtonElement) => void
} | null>(null)

export function ImagePreviewGroup({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<{ images: PreviewImage[]; index: number } | null>(null)
  const [group] = useState(() => {
    const thumbnails = new Map<HTMLButtonElement, PreviewImage>()
    return { thumbnails, open: (button: HTMLButtonElement) => {
      // Markdown 会分块渲染，按页面上的顺序取图，避免流式更新重新挂载时打乱顺序。
      const entries = [...thumbnails].sort(([left], [right]) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      const index = entries.findIndex(([thumbnail]) => thumbnail === button)
      if (index >= 0) setPreview({ images: entries.map(([, image]) => image), index })
    } }
  })
  const close = () => setPreview(null)
  const step = (direction: -1 | 1) => setPreview((current) => {
    if (!current) return current
    const index = current.index + direction
    return index >= 0 && index < current.images.length ? { ...current, index } : current
  })
  const image = preview?.images[preview.index]
  const navigation = preview && preview.images.length > 1
  return (
    <PreviewGroup.Provider value={group}>
      {children}
      {preview && image && (
        <Dialog title={image.alt} placement="full" onClose={close}>
          <ZoomableImage key={preview.index} src={image.src} alt={image.alt} onBlankClick={close}
            onSwipe={navigation ? step : undefined} error={(
            <div className="text-center text-sm text-qn-muted" role="status">
              <p>{t('无法加载图片')}</p>
              {image.externalHref && <a className="qn-button qn-button-ghost mt-2 text-qn-accent underline" href={image.externalHref} target="_blank" rel="noreferrer">{t('在浏览器中打开图片')}</a>}
            </div>
          )} />
          {navigation && (
            <div className="qn-zoom-bar" role="group" aria-label={t('切换图片')}>
              <Button variant="ghost" className="size-11 p-0!" aria-label={t('上一张图片')}
                disabled={preview.index === 0} onClick={() => step(-1)}><ChevronLeft size={20} aria-hidden /></Button>
              <output aria-label={t('图片位置')} className="min-w-10 text-center text-sm text-qn-muted tabular-nums">
                {preview.index + 1} / {preview.images.length}
              </output>
              <Button variant="ghost" className="size-11 p-0!" aria-label={t('下一张图片')}
                disabled={preview.index === preview.images.length - 1} onClick={() => step(1)}><ChevronRight size={20} aria-hidden /></Button>
            </div>
          )}
        </Dialog>
      )}
    </PreviewGroup.Provider>
  )
}

export function ImageThumbnail({ src, alt, className, loading, externalHref, buttonRef }: PreviewImage & {
  className: string
  loading?: 'lazy'
  buttonRef?: (button: HTMLButtonElement | null) => void
}) {
  const group = useContext(PreviewGroup)
  if (!group) throw new Error('ImageThumbnail requires an ImagePreviewGroup')
  return (
    <button type="button" className="qn-image-thumbnail" aria-label={t('查看图片：{alt}', { alt })} aria-haspopup="dialog"
      ref={(button) => {
        if (!button) return
        group.thumbnails.set(button, { src, alt, externalHref })
        buttonRef?.(button)
        return () => {
          group.thumbnails.delete(button)
          buttonRef?.(null)
        }
      }} onClick={(event) => group.open(event.currentTarget)}>
      <img src={src} alt={alt} className={className} loading={loading} decoding="async" />
    </button>
  )
}
