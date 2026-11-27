import { cn } from '../lib/cn'

export function StatusDot({ className, title }: { className: string; title?: string }) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      className={cn('size-1.5 shrink-0 rounded-full motion-reduce:animate-none', className)}
    />
  )
}
