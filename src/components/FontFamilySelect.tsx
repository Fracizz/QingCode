import { useEffect, useMemo, useState, type SelectHTMLAttributes } from 'react'
import {
  loadSystemFontFamilies,
  systemFontOptions,
  withCurrentFontOption,
  type FontKind,
  type FontOption,
} from '../lib/fontSettings'
import { useI18n } from '../lib/i18n'

type Props = {
  value: string
  presets: FontOption[]
  kind: FontKind
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'disabled' | 'className'>

/** Themed font-family select with presets + installed OS fonts. */
export default function FontFamilySelect({
  value,
  presets,
  kind,
  onChange,
  disabled,
  className = '',
  ...rest
}: Props) {
  const { t } = useI18n()
  const [systemFamilies, setSystemFamilies] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void loadSystemFontFamilies().then(fonts => {
      if (!cancelled) setSystemFamilies(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const presetOptions = useMemo(() => {
    const withCurrent = withCurrentFontOption(presets, value)
    const presetValues = new Set(presets.map(option => option.value))
    return withCurrent.filter(
      option => presetValues.has(option.value) || option.value === value,
    )
  }, [presets, value])

  const systemOptions = useMemo(() => {
    const presetValues = new Set(presets.map(option => option.value))
    const presetLabels = presets.map(option => option.label)
    return systemFontOptions(systemFamilies, kind, presetLabels).filter(
      option => !presetValues.has(option.value),
    )
  }, [kind, presets, systemFamilies])

  const knownValues = useMemo(() => {
    const values = new Set<string>()
    for (const option of presetOptions) values.add(option.value)
    for (const option of systemOptions) values.add(option.value)
    return values
  }, [presetOptions, systemOptions])

  // Keep controlled select valid while system fonts are still loading.
  const selectValue = knownValues.has(value) ? value : (presetOptions[0]?.value ?? value)

  return (
    <select
      {...rest}
      value={selectValue}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      className={`setting-control setting-control-wide setting-select ${className}`.trim()}
    >
      <optgroup label={t('预设')}>
        {presetOptions.map(option => (
          <option key={`preset:${option.value}`} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </optgroup>
      {systemOptions.length > 0 && (
        <optgroup label={t('系统字体')}>
          {systemOptions.map(option => (
            <option key={`system:${option.label}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
