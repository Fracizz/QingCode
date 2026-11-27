import { useRef, useState } from 'react'
import { Check, Shield, ShieldAlert } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '../../components/primitives'
import { Modal } from '../../components/ui'
import { cn } from '../../lib/cn'
import type { AgentKind } from '../../../../shared/backendApi'
import { t, accessOptions, type AccessMode, type AccessSelection } from '@qn/codex-client'

export function AccessModePicker({
  agent, mode, inheritedMode, supported, disabled, onChange,
}: {
  agent: AgentKind
  mode: AccessSelection
  inheritedMode: AccessMode
  supported: boolean
  disabled: boolean
  onChange: (mode: AccessSelection) => void
}) {
  const [confirm, setConfirm] = useState<AccessMode | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const openingConfirmation = useRef(false)
  const available = accessOptions[agent]
  if (!available.length) return null
  const effectiveMode = mode === 'inherit' ? inheritedMode : mode
  const current = available.find((option) => option.mode === effectiveMode)
  const pending = available.find((option) => option.mode === confirm)
  if (!current) return null
  const Icon = current.warning ? ShieldAlert : Shield
  const label = mode === 'inherit' ? t('{mode}（跟随总控）', { mode: current.label }) : current.label

  return (
    <>
      <Menu>
        {/* 仅显示图标节省输入区空间，完整模式名放在悬停提示和无障碍标签里。 */}
        <Tip label={t('访问模式：{mode}', { mode: label })}>
          <MenuTrigger asChild>
            <button
              ref={trigger}
              type="button"
              aria-label={t('访问模式：{mode}', { mode: label })}
              disabled={disabled}
              className={cn(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none enabled:hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-outline-hover',
                current.warning ? 'bg-qn-danger/10 text-qn-danger' : effectiveMode !== 'default' ? 'bg-qn-warn/10 text-qn-warn' : 'text-qn-muted',
              )}
            >
              <Icon size={15} />
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
            const next: AccessSelection = option.mode === inheritedMode ? 'inherit' : option.mode
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
          {t('仅应用于当前会话。')}
        </Modal>
      )}
    </>
  )
}
