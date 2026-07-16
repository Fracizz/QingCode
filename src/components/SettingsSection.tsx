import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

type SettingsSectionProps = {
  title: string
  description?: string
  defaultOpen?: boolean
  children: ReactNode
}

export default function SettingsSection({
  title,
  description,
  defaultOpen = false,
  children,
}: SettingsSectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="border-b border-border-strong">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-bg-hover"
      >
        {open ? (
          <ChevronDown size={14} className="mt-0.5 flex-shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={14} className="mt-0.5 flex-shrink-0 text-fg-dim" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{title}</span>
          {description ? (
            <span className="mt-0.5 block text-[12px] leading-relaxed text-fg-muted">{description}</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="px-4 pb-4 pt-1 text-[13px]">
          <div className="pl-[22px]">{children}</div>
        </div>
      ) : null}
    </section>
  )
}
