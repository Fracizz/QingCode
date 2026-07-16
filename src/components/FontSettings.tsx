import { useState } from 'react'
import {
  DEFAULT_FONT_SETTINGS,
  loadFontSettings,
  saveFontSettings,
  type FontSettings,
} from '../lib/fontSettings'

const INTERFACE_FONTS = [
  { label: '系统默认', value: DEFAULT_FONT_SETTINGS.interfaceFont },
  { label: 'Segoe UI', value: '"Segoe UI", "Microsoft YaHei", sans-serif' },
  { label: 'Microsoft YaHei', value: '"Microsoft YaHei", "Segoe UI", sans-serif' },
]

const MONO_FONTS = [
  { label: 'JetBrains Mono', value: DEFAULT_FONT_SETTINGS.monoFont },
  { label: 'Cascadia Code', value: '"Cascadia Code", Consolas, monospace' },
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
]

export default function FontSettings() {
  const [settings, setSettings] = useState(loadFontSettings)

  const update = <K extends keyof FontSettings>(field: K, value: FontSettings[K]) => {
    const next = { ...settings, [field]: value }
    setSettings(next)
    saveFontSettings(next)
  }

  return (
    <div className="flex flex-col gap-5">
      <FontSelect
        label="界面字体"
        description="用于菜单、侧栏、标签和状态栏。"
        value={settings.interfaceFont}
        options={INTERFACE_FONTS}
        onChange={value => update('interfaceFont', value)}
      />
      <FontSizeSelect
        label="界面字体大小"
        value={settings.interfaceFontSize}
        onChange={value => update('interfaceFontSize', value)}
      />
      <FontSelect
        label="代码与终端字体"
        description="代码编辑器与终端共用同一等宽字体族。"
        value={settings.monoFont}
        options={MONO_FONTS}
        onChange={value => update('monoFont', value)}
        monospace
      />
      <FontSizeSelect
        label="代码字体大小"
        description="仅影响编辑器中的代码。"
        value={settings.editorFontSize}
        onChange={value => update('editorFontSize', value)}
        monospace
      />
      <FontSizeSelect
        label="终端字体大小"
        description="仅影响终端面板。"
        value={settings.terminalFontSize}
        onChange={value => update('terminalFontSize', value)}
        monospace
      />
    </div>
  )
}

function FontSizeSelect({
  label,
  value,
  onChange,
  description,
  monospace,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  description?: string
  monospace?: boolean
}) {
  return (
    <label className="block">
      <span className="block font-medium text-fg">{label}</span>
      {description ? <span className="mt-1 block text-xs text-fg-muted">{description}</span> : null}
      <select
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className={`mt-2 w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent ${
          monospace ? 'font-mono' : ''
        }`}
      >
        {[12, 13, 14, 15, 16, 18, 20].map(size => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </select>
    </label>
  )
}

function FontSelect({
  label,
  description,
  value,
  options,
  onChange,
  monospace,
}: {
  label: string
  description: string
  value: string
  options: { label: string; value: string }[]
  onChange: (value: string) => void
  monospace?: boolean
}) {
  return (
    <label className="block">
      <span className="block font-medium text-fg">{label}</span>
      <span className="mt-1 block text-xs text-fg-muted">{description}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className={`mt-2 w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent ${
          monospace ? 'font-mono' : ''
        }`}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
