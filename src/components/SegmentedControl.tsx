import type { ReactNode } from 'react'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
}

/**
 * Unified segmented control (pill container + elevated active segment).
 * Replaces the former per-panel tab strip variants.
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex items-center gap-0.5 bg-bg-active rounded p-0.5 ${className}`}
    >
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex-1 px-2 py-0.5 text-[12px] rounded transition-colors whitespace-nowrap
              ${active ? 'bg-bg-elevated text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
