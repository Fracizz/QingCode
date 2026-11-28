import { useRef, useState } from 'react'
import { Check, ListTodo, Shield, ShieldOff } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '../../components/primitives'
import { Modal } from '../../components/ui'
import type { AgentKind } from '../../../../shared/backendApi'
import { t, sessionAccessOptions, type AccessMode, type SessionAccessMode, type SessionAccessSelection } from '@qn/codex-client'

export function AccessModePicker({
  agent, mode, inheritedMode, supported, disabled, deferred = false, lockedReason, onChange,
}: {
  agent: AgentKind
  mode: SessionAccessSelection
  inheritedMode: AccessMode
  supported: boolean
  disabled: boolean
  /** 当前一轮仍在运行：修改从下一轮开始生效，提示里说明。 */
  deferred?: boolean
  /** 有值时锁定为默认档位（如项目未信任），提示里说明原因。 */
  lockedReason?: string
  onChange: (mode: SessionAccessSelection) => void
}) {
  const [confirm, setConfirm] = useState<SessionAccessMode | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const openingConfirmation = useRef(false)
  const available = sessionAccessOptions(agent)
  if (!available.length) return null
  const effectiveMode = lockedReason ? 'default' : mode === 'inherit' ? inheritedMode : mode
  const current = available.find((option) => option.mode === effectiveMode)
  const pending = available.find((option) => option.mode === confirm)
  if (!current) return null
  // 完全访问用划掉的盾牌和警示色提示没有沙箱限制。
  const Icon = current.warning ? ShieldOff : effectiveMode === 'plan' ? ListTodo : Shield
  const label = lockedReason
    ? t('{mode}（{reason}）', { mode: current.label, reason: lockedReason })
    : mode === 'inherit' ? t('{mode}（跟随总控）', { mode: current.label }) : current.label
  const tip = deferred
    ? t('访问模式：{mode}，修改从下一轮开始生效', { mode: label })
    : t('访问模式：{mode}', { mode: label })

  return (
    <>
      <Menu>
        {/* 仅显示图标节省输入区空间，完整模式名放在悬停提示和无障碍标签里。 */}
        <Tip label={tip}>
          <MenuTrigger asChild>
            <button
              ref={trigger}
              type="button"
              aria-label={tip}
              disabled={disabled || Boolean(lockedReason)}
              data-tone={current.warning ? 'danger' : effectiveMode === 'plan' ? 'accent' : effectiveMode !== 'default' ? 'warn' : 'muted'}
              className="qn-composer-control inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-outline-hover"
            >
              <Icon size={18} strokeWidth={1.75} absoluteStrokeWidth aria-hidden />
            </button>
          </MenuTrigger>
        </Tip>
        <MenuContent
          side="top"
          align="end"
          aria-label={t('访问模式')}
          onCloseAutoFocus={(event) => {
            if (!openingConfirmation.current) return
            // 焦点交给确认框，避免菜单关闭时把它抢回去。
            event.preventDefault()
            openingConfirmation.current = false
          }}
        >
          {available.map((option) => {
            // 选中与总控相同的档位即恢复跟随总控，菜单只保留三档。
            const next: SessionAccessSelection = option.mode === inheritedMode ? 'inherit' : option.mode
            return (
              <MenuItem
                key={option.mode}
                icon={effectiveMode === option.mode ? <Check size={14} /> : <span className="w-3.5" />}
                danger={Boolean(option.warning)}
                disabled={!supported && option.mode !== 'default'}
                onSelect={() => {
                  if (next === mode) return
                  if (next !== 'inherit' && option.warning) {
                    openingConfirmation.current = true
                    setConfirm(option.mode)
                  } else onChange(next)
                }}
              >{option.label}</MenuItem>
            )
          })}
        </MenuContent>
      </Menu>
      {pending?.warning && (
        <Modal
          title={t('启用{mode}？', { mode: pending.label })}
          description={pending.warning}
          onClose={() => setConfirm(null)}
          onOpenAutoFocus={(event) => {
            if (!(event.target instanceof HTMLElement)) return
            event.preventDefault()
            event.target.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus({ preventScroll: true })
          }}
          width="max-w-md"
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={() => setConfirm(null)}>{t('取消')}</button>
              <button
                type="button"
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                disabled={disabled || !supported}
                onClick={() => {
                  onChange(pending.mode)
                  setConfirm(null)
                }}
              >{t('启用')}</button>
            </div>
          )}
        >
          {deferred ? t('仅应用于当前会话，从下一轮开始生效。') : t('仅应用于当前会话。')}
        </Modal>
      )}
    </>
  )
}
