import { LoaderCircle, type LucideProps } from 'lucide-react'
import { cn } from '../lib/cn'

export function LoadingIcon({ className, ...props }: LucideProps) {
  return (
    <LoaderCircle
      size={14}
      aria-hidden="true"
      className={cn('shrink-0 animate-spin motion-reduce:animate-none', className)}
      {...props}
    />
  )
}
