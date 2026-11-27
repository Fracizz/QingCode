import { useMemo, useState } from 'react'
import { Binary, Download, ExternalLink } from 'lucide-react'
import { t } from '@qn/codex-client'
import { cn } from '../../lib/cn'
import { basename, imageDataUrl } from './fileLinks'

type DownloadAction = (openAfterDownload: boolean) => Promise<void>

export function ImageView({
  content,
  path,
  className,
  onDownload,
}: {
  content: string
  path: string
  className?: string
  onDownload?: DownloadAction
}) {
  const src = useMemo(() => imageDataUrl(content, path), [content, path])
  const [originalSize, setOriginalSize] = useState(false)
  if (!src) return <BinaryNotice path={path} className={className} onDownload={onDownload} />
  return (
    <div className={cn('qn-scroll flex min-h-0 flex-1 overflow-auto bg-qn-code p-4', className)}>
      <button
        type="button"
        className={cn('m-auto flex shrink-0 items-center justify-center', originalSize ? 'cursor-zoom-out' : 'h-full w-full cursor-zoom-in')}
        aria-label={originalSize ? t('适应窗口') : t('查看原始尺寸')}
        title={originalSize ? t('适应窗口') : t('查看原始尺寸')}
        aria-pressed={originalSize}
        onClick={() => setOriginalSize((value) => !value)}
      >
        <img src={src} alt={basename(path)} className={originalSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'} />
      </button>
    </div>
  )
}

export function BinaryNotice({
  path,
  message = t('这是二进制文件，无法按文本显示'),
  className,
  onDownload,
}: {
  path: string
  message?: string
  className?: string
  onDownload?: DownloadAction
}) {
  const [downloading, setDownloading] = useState(false)
  const download = async (openAfterDownload: boolean) => {
    if (!onDownload) return
    setDownloading(true)
    try {
      await onDownload(openAfterDownload)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center', className)}>
      <Binary size={28} className="text-qn-dim" />
      <div className="text-ui text-qn-muted">{message}</div>
      <div className="max-w-full truncate font-mono text-ui-sm text-qn-dim">{path}</div>
      {onDownload && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <button type="button" className="qn-button-subtle inline-flex items-center gap-1.5"
            disabled={downloading} onClick={() => void download(false)}>
            <Download size={14} aria-hidden />
            {t('下载')}
          </button>
          <button type="button" className="qn-button-subtle inline-flex items-center gap-1.5"
            disabled={downloading} onClick={() => void download(true)}>
            <ExternalLink size={14} aria-hidden />
            {t('下载并打开')}
          </button>
        </div>
      )}
      {downloading && <div role="status" className="text-ui-sm text-qn-muted">{t('正在下载…')}</div>}
    </div>
  )
}
