import { useState } from 'react'
import {
  FONT_SIZE_OPTIONS,
  INTERFACE_FONT_OPTIONS,
  MONO_FONT_OPTIONS,
  loadFontSettings,
  saveFontSettings,
  withCurrentFontOption,
  type FontSettings,
} from '../lib/fontSettings'
import { useI18n } from '../lib/i18n'

export default function FontSettings() {
  const { t } = useI18n()
  const [settings, setSettings] = useState(loadFontSettings)

  const update = <K extends keyof FontSettings>(field: K, value: FontSettings[K]) => {
    const next = { ...settings, [field]: value }
    setSettings(next)
    saveFontSettings(next)
  }

  return (
    <div className="flex flex-col gap-6">
      <FontGroup
        title={t('界面字体')}
        description={t('用于菜单、侧栏、标签和状态栏，支持选择系统默认字体。')}
        fontLabel={t('字体')}
        fontValue={settings.interfaceFont}
        fontOptions={withCurrentFontOption(INTERFACE_FONT_OPTIONS, settings.interfaceFont)}
        onFontChange={value => update('interfaceFont', value)}
        sizeLabel={t('字号')}
        sizeValue={settings.interfaceFontSize}
        onSizeChange={value => update('interfaceFontSize', value)}
      />

      <FontGroup
        title={t('代码与终端字体')}
        description={t('代码编辑器与终端共用同一等宽字体族，支持选择系统默认字体。')}
        fontLabel={t('字体')}
        fontValue={settings.monoFont}
        fontOptions={withCurrentFontOption(MONO_FONT_OPTIONS, settings.monoFont)}
        onFontChange={value => update('monoFont', value)}
        monospace
        sizeLabel={t('代码字号')}
        sizeValue={settings.editorFontSize}
        onSizeChange={value => update('editorFontSize', value)}
        extraSizeLabel={t('终端字号')}
        extraSizeValue={settings.terminalFontSize}
        onExtraSizeChange={value => update('terminalFontSize', value)}
      />
    </div>
  )
}

function FontGroup({
  title,
  description,
  fontLabel,
  fontValue,
  fontOptions,
  onFontChange,
  sizeLabel,
  sizeValue,
  onSizeChange,
  extraSizeLabel,
  extraSizeValue,
  onExtraSizeChange,
  monospace,
}: {
  title: string
  description: string
  fontLabel: string
  fontValue: string
  fontOptions: { label: string; value: string }[]
  onFontChange: (value: string) => void
  sizeLabel: string
  sizeValue: number
  onSizeChange: (value: number) => void
  extraSizeLabel?: string
  extraSizeValue?: number
  onExtraSizeChange?: (value: number) => void
  monospace?: boolean
}) {
  const { t } = useI18n()
  const fieldClass = `w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent ${
    monospace ? 'font-mono' : ''
  }`

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-fg">{title}</h3>
        <p className="mt-1 text-xs text-fg-muted">{description}</p>
      </div>
      <label className="block">
        <span className="block text-xs font-medium text-fg-muted">{fontLabel}</span>
        <select
          value={fontValue}
          onChange={event => onFontChange(event.target.value)}
          className={`mt-1.5 ${fieldClass}`}
          style={monospace ? { fontFamily: 'var(--font-mono)' } : { fontFamily: 'var(--font-sans)' }}
        >
          {fontOptions.map(option => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </label>
      <div className={`grid gap-3 ${extraSizeLabel ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <FontSizeField
          label={sizeLabel}
          value={sizeValue}
          onChange={onSizeChange}
          className={fieldClass}
        />
        {extraSizeLabel && extraSizeValue != null && onExtraSizeChange ? (
          <FontSizeField
            label={extraSizeLabel}
            value={extraSizeValue}
            onChange={onExtraSizeChange}
            className={fieldClass}
          />
        ) : null}
      </div>
    </section>
  )
}

function FontSizeField({
  label,
  value,
  onChange,
  className,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  className: string
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-fg-muted">{label}</span>
      <select value={value} onChange={event => onChange(Number(event.target.value))} className={`mt-1.5 ${className}`}>
        {FONT_SIZE_OPTIONS.map(size => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </select>
    </label>
  )
}
