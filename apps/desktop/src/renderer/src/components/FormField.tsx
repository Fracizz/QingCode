import { useId, type ReactNode } from 'react'
import { cn } from '../lib/cn'

type FieldControlProps = {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export function FormField({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  className?: string
  children: (props: FieldControlProps) => ReactNode
}) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="text-ui-sm text-qn-muted">{label}</label>
      {children({
        id,
        'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {hint && <p id={hintId} className="text-ui-sm leading-5 text-qn-dim">{hint}</p>}
      {error && <p id={errorId} className="text-ui-sm leading-5 text-qn-danger">{error}</p>}
    </div>
  )
}
