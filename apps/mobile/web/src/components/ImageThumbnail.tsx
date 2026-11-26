import { useState } from 'react'
import { Dialog, Loading } from './ui'

type ImageThumbnailProps = {
  src: string
  alt: string
  className: string
  loading?: 'lazy'
  externalHref?: string
}

export function ImageThumbnail({ src, alt, className, loading, externalHref }: ImageThumbnailProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')

  return (
    <>
      <button type="button" className="qn-image-thumbnail" aria-label={`查看图片：${alt}`} aria-haspopup="dialog"
        onClick={() => { setStatus('loading'); setOpen(true) }}>
        <img src={src} alt={alt} className={className} loading={loading} decoding="async" />
      </button>
      {open && (
        <Dialog title={alt} placement="full" onClose={() => setOpen(false)}>
          <div className="qn-image-preview">
            {status === 'failed' ? (
              <div className="text-center text-sm text-qn-muted" role="status">
                <p>无法加载图片</p>
                {externalHref && <a className="qn-button qn-button-ghost mt-2 text-qn-accent underline" href={externalHref} target="_blank" rel="noreferrer">在浏览器中打开图片</a>}
              </div>
            ) : <img src={src} alt={alt} className={status === 'loading' ? 'invisible' : undefined}
              onLoad={() => setStatus('ready')} onError={() => setStatus('failed')} />}
            {status === 'loading' && <Loading text="正在加载图片…" />}
          </div>
        </Dialog>
      )}
    </>
  )
}
