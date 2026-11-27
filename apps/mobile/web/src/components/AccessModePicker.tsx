import { accessOptions, inheritedAccessOption, type AccessMode, type AccessSelection } from '@qn/codex-client'
import { Check, Shield, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { AgentKind } from '../types'
import { Button, Dialog } from './ui'

export function AccessModePicker({ agent, mode, effectiveMode, inheritedMode, supported, disabled, onChange }: {
  agent: AgentKind
  mode: AccessSelection
  effectiveMode: AccessMode
  inheritedMode?: AccessMode
  supported: boolean
  disabled: boolean
  onChange: (mode: AccessSelection) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<AccessMode | null>(null)
  const available = accessOptions[agent]
  const current = available.find((option) => option.mode === effectiveMode)
  const pending = available.find((option) => option.mode === confirm)
  if (!current) return null
  const inherited = inheritedMode
    ? inheritedAccessOption(agent, inheritedMode)
    : { mode: 'inherit' as const, label: '继承总控', hint: '使用电脑当前的权限设置' }
  const options = [inherited, ...available]
  const Icon = current.warning ? ShieldAlert : Shield
  const label = mode === 'inherit' ? (effectiveMode === 'default' ? '继承总控' : `继承总控 · ${current.label}`) : current.label
  const close = () => {
    setOpen(false)
    setConfirm(null)
  }
  const select = (next: AccessSelection) => {
    onChange(next)
    close()
  }

  return (
    <>
      <Button variant="ghost" className="qn-access-chip"
        data-tone={current.warning ? 'danger' : effectiveMode !== 'default' ? 'warn' : undefined}
        aria-label={`访问模式：${label}`} aria-haspopup="dialog" aria-expanded={open}
        title={label} disabled={disabled} onClick={() => setOpen(true)}>
        <Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden />
        {effectiveMode !== 'default' && <span>{current.label}</span>}
      </Button>
      {open && (
        <Dialog title={pending ? `启用${pending.label}？` : '访问模式'} onClose={close}>
          {pending ? (
            <>
              <p className="mb-4 text-sm">{pending.warning} 仅应用于当前会话。</p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirm(null)}>取消</Button>
                <Button variant="danger" disabled={disabled || !supported} onClick={() => select(pending.mode)}>启用</Button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {!supported && <p className="text-xs text-qn-muted">当前电脑或目标服务版本暂不支持会话权限覆盖。</p>}
              {options.map((option) => (
                <button key={option.mode} type="button" aria-pressed={option.mode === mode}
                  className="qn-row rounded-xl border border-qn-border px-3 py-2 disabled:opacity-50"
                  disabled={disabled || (!supported && option.mode !== 'default' &&
                    (option.mode !== 'inherit' || (inheritedMode !== undefined && inheritedMode !== 'default')))}
                  onClick={() => {
                    if (option.mode !== 'inherit' && option.mode !== mode && option.warning) setConfirm(option.mode)
                    else select(option.mode)
                  }}>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-medium${option.warning ? ' text-qn-danger' : ''}`}>{option.label}</span>
                    <span className="block text-xs text-qn-muted">{option.hint}</span>
                  </span>
                  {option.mode === mode && <Check size={16} className="shrink-0 text-qn-accent" aria-hidden />}
                </button>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </>
  )
}
