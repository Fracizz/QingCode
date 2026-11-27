import type { ComponentPropsWithRef } from 'react'
import { cn } from '../lib/cn'

export function ListOption({
  selected,
  className,
  ...props
}: ComponentPropsWithRef<'button'> & { selected: boolean }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-outline-hover',
        selected ? 'bg-qn-active' : 'hover:bg-qn-hover',
        className,
      )}
      {...props}
    />
  )
}
