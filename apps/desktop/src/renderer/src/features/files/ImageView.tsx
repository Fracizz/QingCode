import { useMemo } from 'react'
import { Binary } from 'lucide-react'
import { cn } from '../../lib/cn'
import { basename, imageDataUrl } from './fileLinks'

export function ImageView({
  content,
  path,
  className,
}: {
  content: string
  path: string
  className?: string
}) {
  const src = useMemo(() => imageDataUrl(content, path), [content, path])
  if (!src) return <BinaryNotice path={path} className={className} />
  return (
    <div className={cn('qn-scroll flex min-h-0 flex-1 items-center justify-center overflow-auto bg-qn-code p-4', className)}>
      <img src={src} alt={basename(path)} className="max-h-full max-w-full object-contain" />
    </div>
  )
}

export function BinaryNotice({
  path,
  message = '这是二进制文件，无法按文本显示',
  className,
}: {
  path: string
  message?: string
  className?: string
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center', className)}>
      <Binary size={28} className="text-qn-dim" />
      <div className="text-ui text-qn-muted">{message}</div>
      <div className="max-w-full truncate font-mono text-ui-sm text-qn-dim">{path}</div>
    </div>
  )
}
