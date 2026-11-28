import { sessionAccessOptions, type AccessMode, type SessionAccessMode, type SessionAccessSelection, t } from '@qn/codex-client'
import { Check, ListTodo, Shield, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { AgentKind } from '../types'
import { Button, Dialog } from './ui'

// 三档各用一个盾牌图标：输入框里只放图标省出宽度，文字只在切换弹窗中显示。
// 完全访问用「盾牌划掉」，与电脑端一致。
export const MODE_ICONS: Record<SessionAccessMode, LucideIcon> = {
  default: Shield, auto: ShieldCheck, fullAccess: ShieldOff, plan: ListTodo,
}

export function AccessModePicker({ agent, mode, effectiveMode, inheritedMode, supported, disabled, deferred = false, onChange }: {
  agent: AgentKind
  mode: SessionAccessSelection
  effectiveMode: SessionAccessMode
  inheritedMode?: AccessMode
  supported: boolean
  disabled: boolean
  /** 当前一轮仍在运行：修改从下一轮开始生效，弹窗里说明。 */
  deferred?: boolean
  onChange: (mode: SessionAccessSelection) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<SessionAccessMode | null>(null)
  const available = sessionAccessOptions(agent)
  const current = available.find((option) => option.mode === effectiveMode)
  const pending = available.find((option) => option.mode === confirm)
  if (!current) return null
  const Icon = MODE_ICONS[current.mode]
  const label = mode === 'inherit' ? t('{label}（跟随总控）', { label: current.label }) : current.label
  const close = () => {
    setOpen(false)
    setConfirm(null)
  }
  const select = (next: SessionAccessSelection) => {
    onChange(next)
    close()
  }

  return (
    <>
      <Button variant="ghost" className="qn-access-chip"
        data-tone={current.warning ? 'danger' : effectiveMode === 'plan' ? 'accent' : effectiveMode !== 'default' ? 'warn' : undefined}
        aria-label={t('访问模式：{label}', { label })} aria-haspopup="dialog" aria-expanded={open}
        title={label} disabled={disabled} onClick={() => setOpen(true)}>
        <Icon size={20} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" aria-hidden />
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
                const next: SessionAccessSelection = option.mode === inheritedMode ? 'inherit' : option.mode
                const OptionIcon = MODE_ICONS[option.mode]
                return (
                  <button key={option.mode} type="button" aria-pressed={option.mode === effectiveMode}
                    className="qn-row qn-surface gap-3 px-3 py-2 disabled:opacity-50"
                    disabled={disabled || (!supported && option.mode !== 'default')}
                    onClick={() => {
                      if (next === mode) close()
                      else if (next !== 'inherit' && option.warning) setConfirm(option.mode)
                      else select(next)
                    }}>
                    <OptionIcon size={18} strokeWidth={1.75} aria-hidden
                      className={`shrink-0 ${option.warning ? 'text-qn-danger' : option.mode === 'auto' ? 'text-qn-warn'
                        : option.mode === 'plan' ? 'text-qn-accent' : 'text-qn-muted'}`} />
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

/**
 * pi 原生没有审批机制（docs/agent-adapters.md）：不能伪造档位切换，但要如实提示。
 * 输入框里与其它 Agent 一样只放红色「盾牌划掉」图标，省出宽度给模型名；点开看完整说明。
 */
export function NoApprovalNotice() {
  const [open, setOpen] = useState(false)
  const label = t('无审批：工具直接执行')
  return (
    <>
      <Button variant="ghost" className="qn-access-chip" data-tone="danger"
        aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={label} onClick={() => setOpen(true)}>
        <ShieldOff size={20} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" aria-hidden />
      </Button>
      {open && (
        <Dialog title={t('访问模式')} onClose={() => setOpen(false)}>
          <div className="qn-row qn-surface gap-3 px-3 py-2">
            <ShieldOff size={18} strokeWidth={1.75} className="shrink-0 text-qn-danger" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-qn-danger">{label}</span>
              <span className="block text-xs text-qn-muted">{t('pi 不经审批直接执行工具')}</span>
            </span>
          </div>
        </Dialog>
      )}
    </>
  )
}
