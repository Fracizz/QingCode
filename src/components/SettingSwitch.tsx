import type { ReactNode } from 'react'

/** 设置行开关：左侧文字、右侧滑块；原生 checkbox 保留键盘与读屏语义。 */
export default function SettingSwitch({ label, checked, disabled, onChange, className = 'text-ui text-fg' }: {
  label: ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  return <label className={`flex cursor-pointer items-center justify-between gap-3 ${className}`}>
    {label}
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="peer sr-only" />
    <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors peer-disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-border-strong'}`}>
      <span className={`h-4 w-4 rounded-full bg-fg shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </span>
  </label>
}
