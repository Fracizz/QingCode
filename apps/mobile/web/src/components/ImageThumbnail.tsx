import { t } from '@qn/codex-client'
import { useState } from 'react'
import { Dialog } from './ui'
import { ZoomableImage } from './ZoomableImage'

type ImageThumbnailProps = {
  src: string
  alt: string
  className: string
  loading?: 'lazy'
  externalHref?: string
}

export function ImageThumbnail({ src, alt, className, loading, externalHref }: ImageThumbnailProps) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <>
      <button type="button" className="qn-image-thumbnail" aria-label={t('查看图片：{alt}', { alt })} aria-haspopup="dialog"
        onClick={() => setOpen(true)}>
        <img src={src} alt={alt} className={className} loading={loading} decoding="async" />
      </button>
      {open && (
        <Dialog title={alt} placement="full" onClose={close}>
          <ZoomableImage src={src} alt={alt} onBlankClick={close} error={(
            <div className="text-center text-sm text-qn-muted" role="status">
              <p>{t('无法加载图片')}</p>
              {externalHref && <a className="qn-button qn-button-ghost mt-2 text-qn-accent underline" href={externalHref} target="_blank" rel="noreferrer">{t('在浏览器中打开图片')}</a>}
            </div>
          )} />
        </Dialog>
      )}
    </>
  )
}
