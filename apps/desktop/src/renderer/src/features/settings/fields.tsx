import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-3">
      <h2 className="text-[15px] font-semibold text-qn-text">{title}</h2>
      {description && <p className="mt-1 text-[12px] leading-5 text-qn-dim">{description}</p>}
    </header>
  )
}

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-qn-border py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-qn-text">{title}</div>
        {description && <p className="mt-1 text-[12px] leading-5 text-qn-dim">{description}</p>}
      </div>
      <div className="w-full shrink-0 sm:w-[17rem]">{children}</div>
    </div>
  )
}

/** 禁用原生 radio：分段按钮只在已支持的选项间单选。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; hint?: string }>
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div
      role="group"
      className={cn('inline-flex rounded-lg border border-qn-border-strong bg-[#161616] p-0.5', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => {
            if (!option.disabled) onChange(option.value)
          }}
          className={cn(
            'rounded-md px-2.5 py-1 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
            value === option.value ? 'bg-qn-hover text-qn-text' : 'text-qn-muted hover:text-qn-text',
            option.disabled && 'cursor-not-allowed text-qn-dim',
          )}
        >
          {option.label}
          {option.hint && <span className="ml-1 text-[11px] text-qn-dim">{option.hint}</span>}
        </button>
      ))}
    </div>
  )
}

/** 路径类输入在失焦或 Enter 时才提交，避免每敲一个字符都写一次磁盘。 */
export function DeferredInput({
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  value: string
  placeholder?: string
  ariaLabel: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className="qn-input"
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          setDraft(value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[12px] text-qn-muted">{children}</div>
}

export function InfoBlock({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-qn-border bg-white/[0.02] px-3 py-2.5 text-[12px] leading-5 text-qn-muted">
      {title && <div className="mb-1 text-[13px] text-qn-text">{title}</div>}
      {children}
    </div>
  )
}
