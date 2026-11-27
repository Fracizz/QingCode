import { accessOptions, type AccessMode, type AccessSelection, t } from '@qn/codex-client'
import { Check, Shield, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { AgentKind } from '../types'
import { Button, Dialog } from './ui'

// 三档各用一个盾牌图标：输入框里只放图标省出宽度，文字只在切换弹窗中显示。
export const MODE_ICONS: Record<AccessMode, LucideIcon> = { default: Shield, auto: ShieldCheck, fullAccess: ShieldAlert }

export function AccessModePicker({ agent, mode, effectiveMode, inheritedMode, supported, disabled, deferred = false, onChange }: {
  agent: AgentKind
  mode: AccessSelection
  effectiveMode: AccessMode
  inheritedMode?: AccessMode
  supported: boolean
  disabled: boolean
  /** 当前一轮仍在运行：修改从下一轮开始生效，弹窗里说明。 */
  deferred?: boolean
  onChange: (mode: AccessSelection) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<AccessMode | null>(null)
  const available = accessOptions[agent]
  const current = available.find((option) => option.mode === effectiveMode)
  const pending = available.find((option) => option.mode === confirm)
  if (!current) return null
  const Icon = MODE_ICONS[current.mode]
  const label = mode === 'inherit' ? t('{label}（跟随总控）', { label: current.label }) : current.label
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
        aria-label={t('访问模式：{label}', { label })} aria-haspopup="dialog" aria-expanded={open}
        title={label} disabled={disabled} onClick={() => setOpen(true)}>
        <Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden />
      </Button>
      {open && (
        <Dialog title={pending ? t('启用{label}？', { label: pending.label }) : t('访问模式')} onClose={close}>
          {pending ? (
            <>
              <p className="mb-4 text-sm">{pending.warning} {deferred ? t('仅应用于当前会话，从下一轮开始生效。') : t('仅应用于当前会话。')}</p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setConfirm(null)}>{t('取消')}</Button>
                <Button variant="danger" disabled={disabled || !supported} onClick={() => select(pending.mode)}>{t('启用')}</Button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {!supported && <p className="text-xs text-qn-muted">{t('当前电脑或目标服务版本暂不支持会话权限覆盖。')}</p>}
              {deferred && <p className="text-xs text-qn-muted">{t('本轮仍在运行，修改从下一轮开始生效。')}</p>}
              {available.map((option) => {
                // 选中与总控相同的档位即恢复跟随总控；总控未知时保持显式选择。
                const next: AccessSelection = option.mode === inheritedMode ? 'inherit' : option.mode
                const OptionIcon = MODE_ICONS[option.mode]
                return (
                  <button key={option.mode} type="button" aria-pressed={option.mode === effectiveMode}
                    className="qn-row gap-3 rounded-xl border border-qn-border px-3 py-2 disabled:opacity-50"
                    disabled={disabled || (!supported && option.mode !== 'default')}
                    onClick={() => {
                      if (next === mode) close()
                      else if (next !== 'inherit' && option.warning) setConfirm(option.mode)
                      else select(next)
                    }}>
                    <OptionIcon size={18} strokeWidth={1.75} aria-hidden
                      className={`shrink-0 ${option.warning ? 'text-qn-danger' : option.mode === 'auto' ? 'text-qn-warn' : 'text-qn-muted'}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm font-medium${option.warning ? ' text-qn-danger' : ''}`}>{option.label}</span>
                      <span className="block text-xs text-qn-muted">{option.hint}</span>
                    </span>
                    {option.mode === effectiveMode && <Check size={16} className="shrink-0 text-qn-accent" aria-hidden />}
                  </button>
                )
              })}
            </div>
          )}
        </Dialog>
      )}
    </>
  )
}
