import { convertFileSrc } from '@tauri-apps/api/core'
import { forwardRef, useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '../lib/i18n'
import { authorizePaths } from '../lib/pathAllowlist'
import { isTauri } from '../lib/tauri'
import { resolveMarkdownLocalImagePath } from '../lib/markdownLocalImages'

type Props = {
  content: string
  filePath: string
  className?: string
}

type MarkdownImageProps = ComponentPropsWithoutRef<'img'> & {
  markdownPath: string
}

const localImageUrlCache = new Map<string, Promise<string>>()

function localImageUrl(path: string): Promise<string> {
  const key = path.replace(/\\/g, '/').toLocaleLowerCase()
  const cached = localImageUrlCache.get(key)
  if (cached) return cached
  const pending = authorizePaths([path])
    .then(() => convertFileSrc(path))
    .catch(error => {
      localImageUrlCache.delete(key)
      throw error
    })
  localImageUrlCache.set(key, pending)
  return pending
}

function MarkdownImage({ markdownPath, src, alt, ...props }: MarkdownImageProps) {
  const localPath = useMemo(
    () => resolveMarkdownLocalImagePath(markdownPath, src),
    [markdownPath, src],
  )
  const desktopLocalPath = localPath && isTauri() ? localPath : null
  const [loadResult, setLoadResult] = useState<{
    path: string
    url?: string
    failed?: boolean
  }>({ path: '' })

  useEffect(() => {
    if (!desktopLocalPath) return

    let cancelled = false
    void localImageUrl(desktopLocalPath)
      .then(url => {
        if (!cancelled) setLoadResult({ path: desktopLocalPath, url })
      })
      .catch(() => {
        if (!cancelled) setLoadResult({ path: desktopLocalPath, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [desktopLocalPath])

  if (!desktopLocalPath) {
    return <img {...props} src={src} alt={alt ?? ''} loading="lazy" />
  }
  if (loadResult.path === desktopLocalPath && loadResult.failed) {
    return <span className="qing-md-image-error">{alt || src}</span>
  }
  if (loadResult.path !== desktopLocalPath || !loadResult.url) {
    return <span className="qing-md-image-loading">{alt}</span>
  }
  return <img {...props} src={loadResult.url} alt={alt ?? ''} loading="lazy" />
}

/** Lightweight Markdown preview for `.md` editor tabs. */
const MarkdownPreview = forwardRef<HTMLDivElement, Props>(function MarkdownPreview(
  { content, filePath, className = '' },
  ref,
) {
  const { t } = useI18n()
  const body = useMemo(() => content || '', [content])
  const empty = !body.trim()

  return (
    <div
      ref={ref}
      className={`qing-md-preview h-full overflow-auto px-5 py-4 text-[14px] leading-relaxed text-fg ${className}`}
    >
      {empty ? (
        <div className="flex h-full items-center justify-center text-fg-dim text-sm">{t('预览为空')}</div>
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
            img: props => <MarkdownImage {...props} markdownPath={filePath} />,
          }}
        >
          {body}
        </ReactMarkdown>
      )}
    </div>
  )
})

export default MarkdownPreview
