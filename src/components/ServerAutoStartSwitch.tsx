import { useI18n } from '../lib/i18n'

export default function ServerAutoStartSwitch({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useI18n()
  return <label className="flex cursor-pointer items-center justify-between gap-3 text-ui text-fg">
    {t('开机自启 Server')}
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="peer sr-only" />
    <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors peer-disabled:opacity-40 ${checked ? 'bg-accent' : 'bg-border-strong'}`}>
      <span className={`h-4 w-4 rounded-full bg-fg shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </span>
  </label>
}
