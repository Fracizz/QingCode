import { t } from '@qn/codex-client'
import { useState } from 'react'
import { BottomClose, Dialog, Loading } from './ui'

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
      <button type="button" className="qn-image-thumbnail" aria-label={t('查看图片：{alt}', { alt })} aria-haspopup="dialog"
        onClick={() => { setStatus('loading'); setOpen(true) }}>
        <img src={src} alt={alt} className={className} loading={loading} decoding="async" />
      </button>
      {open && (
        <Dialog title={alt} placement="full" closeAt="none" onClose={() => setOpen(false)}>
          {/* 关闭按钮紧贴在图片下方，点图片外的空白处也能关。 */}
          <div className="qn-image-preview" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
            {status === 'failed' ? (
              <div className="text-center text-sm text-qn-muted" role="status">
                <p>{t('无法加载图片')}</p>
                {externalHref && <a className="qn-button qn-button-ghost mt-2 text-qn-accent underline" href={externalHref} target="_blank" rel="noreferrer">{t('在浏览器中打开图片')}</a>}
              </div>
            ) : <img src={src} alt={alt} className={status === 'loading' ? 'invisible' : undefined}
              onLoad={() => setStatus('ready')} onError={() => setStatus('failed')} />}
            {status === 'loading' && <Loading text={t('正在加载图片…')} />}
            <BottomClose autoFocus onClick={() => setOpen(false)} />
          </div>
        </Dialog>
      )}
    </>
  )
}
