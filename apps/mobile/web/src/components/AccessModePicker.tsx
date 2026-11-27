import { accessOptions, type AccessMode } from '@qn/codex-client'
import { Check, ChevronDown, Shield, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { AgentKind } from '../types'
import { Button, Dialog } from './ui'

export function AccessModePicker({ agent, mode, supported, disabled, onChange }: {
  agent: AgentKind
  mode: AccessMode
  supported: boolean
  disabled: boolean
  onChange: (mode: AccessMode) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<AccessMode | null>(null)
  const options = accessOptions[agent]
  const current = options.find((option) => option.mode === mode)
  const pending = options.find((option) => option.mode === confirm)
  if (!current) return null
  const Icon = current.warning ? ShieldAlert : Shield
  const close = () => {
    setOpen(false)
    setConfirm(null)
  }
  const select = (next: AccessMode) => {
    onChange(next)
    close()
  }

  return (
    <>
      <button type="button" className="qn-chip qn-access-chip"
        data-tone={current.warning ? 'danger' : mode !== 'default' ? 'warn' : undefined}
        aria-label={`访问模式：${current.label}`} aria-haspopup="dialog" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen(true)}>
        <Icon size={14} className="shrink-0" aria-hidden />
        {current.label}
        <ChevronDown size={13} className="shrink-0" aria-hidden />
      </button>
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
              {!supported && <p className="text-xs text-qn-muted">当前电脑或目标服务版本只支持默认权限。</p>}
              {options.map((option) => (
                <button key={option.mode} type="button" aria-pressed={option.mode === mode}
                  className="qn-row rounded-xl border border-qn-border px-3 py-2 disabled:opacity-50"
                  disabled={disabled || (!supported && option.mode !== 'default')}
                  onClick={() => {
                    if (option.mode !== mode && option.warning) setConfirm(option.mode)
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
