import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../lib/cn'

export function SearchField({
  label,
  className,
  inputClassName,
  icon = <Search size={15} />,
  boxed,
  onClear,
  ...props
}: ComponentPropsWithRef<'input'> & {
  label: string
  inputClassName?: string
  icon?: ReactNode
  boxed?: boolean
  onClear?: () => void
}) {
  return (
    <div className={cn('relative flex min-w-0 items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className={cn('pointer-events-none inline-flex shrink-0 text-qn-dim', boxed && 'absolute inset-y-0 left-2.5 items-center')}
      >
        {icon}
      </span>
      <input
        aria-label={label}
        className={cn(
          'min-w-0 flex-1 placeholder:text-qn-dim',
          boxed ? 'qn-input pl-8' : 'bg-transparent text-ui text-qn-text outline-none',
          onClear && 'pr-8',
          inputClassName,
        )}
        {...props}
      />
      {onClear && (
        <button
          type="button"
          aria-label="清空搜索"
          className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-md text-qn-muted hover:bg-qn-hover hover:text-qn-text focus-visible:outline-1 focus-visible:outline-current"
          onClick={onClear}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
