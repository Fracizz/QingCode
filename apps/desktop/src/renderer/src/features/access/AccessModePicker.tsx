import { useRef, useState } from 'react'
import { Check, ChevronDown, Shield, ShieldAlert } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/primitives'
import { Modal } from '../../components/ui'
import { cn } from '../../lib/cn'
import type { AgentKind } from '../../../../shared/backendApi'
import { accessOptions, inheritedAccessOption, type AccessMode, type AccessSelection } from '@qn/codex-client'

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
  const options = [inheritedAccessOption(agent, inheritedMode), ...available]
  const effectiveMode = mode === 'inherit' ? inheritedMode : mode
  const current = available.find((option) => option.mode === effectiveMode)
  const pending = available.find((option) => option.mode === confirm)
  if (!current) return null
  const Icon = current.warning ? ShieldAlert : Shield
  const label = mode === 'inherit' ? (effectiveMode === 'default' ? '继承总控' : `继承总控 · ${current.label}`) : current.label

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label={`访问模式：${label}`}
            disabled={disabled}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] outline-none enabled:hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent',
              current.warning ? 'bg-qn-danger/10 text-qn-danger' : effectiveMode !== 'default' ? 'bg-qn-warn/10 text-qn-warn' : 'text-qn-muted',
            )}
          >
            <Icon size={14} />
            {label}
            <ChevronDown size={13} />
          </button>
        </MenuTrigger>
        <MenuContent
          side="top"
          align="end"
          aria-label="访问模式"
          onCloseAutoFocus={(event) => {
            if (!openingConfirmation.current) return
            // 焦点交给确认框，避免菜单关闭时把它抢回去。
            event.preventDefault()
            openingConfirmation.current = false
          }}
        >
          {options.map((option) => (
            <MenuItem
              key={option.mode}
              icon={mode === option.mode ? <Check size={14} /> : <span className="w-3.5" />}
              hint={<span className="text-qn-muted">{option.hint}</span>}
              danger={Boolean(option.warning)}
              disabled={!supported && option.mode !== 'default' && (option.mode !== 'inherit' || inheritedMode !== 'default')}
              onSelect={() => {
                if (option.mode === mode) return
                if (option.mode !== 'inherit' && option.warning) {
                  openingConfirmation.current = true
                  setConfirm(option.mode)
                } else onChange(option.mode)
              }}
            >{option.label}</MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {pending?.warning && (
        <Modal
          title={`启用${pending.label}？`}
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
              <button type="button" className="qn-button-subtle" onClick={() => setConfirm(null)}>取消</button>
              <button
                type="button"
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                disabled={disabled || !supported}
                onClick={() => {
                  onChange(pending.mode)
                  setConfirm(null)
                }}
              >启用</button>
            </div>
          )}
        >
          仅应用于当前会话。
        </Modal>
      )}
    </>
  )
}
