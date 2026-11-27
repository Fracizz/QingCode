import { useState } from 'react'
import { Check, ChevronDown, Shield, ShieldAlert } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/primitives'
import { Modal } from '../../components/ui'
import { cn } from '../../lib/cn'
import type { AgentKind } from '../../../../shared/backendApi'
import { accessOptions, type AccessMode } from './accessModel'

export function AccessModePicker({
  agent, mode, disabled, onChange,
}: {
  agent: AgentKind
  mode: AccessMode
  disabled: boolean
  onChange: (mode: AccessMode) => void
}) {
  const [confirm, setConfirm] = useState<AccessMode | null>(null)
  const options = accessOptions[agent]
  const current = options.find((option) => option.mode === mode)
  const pending = options.find((option) => option.mode === confirm)
  if (!current) return null
  const Icon = current.warning ? ShieldAlert : Shield

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={`访问模式：${current.label}`}
            disabled={disabled}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-ui outline-none enabled:hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent',
              current.warning ? 'bg-qn-danger/10 text-qn-danger' : mode !== 'default' ? 'bg-qn-warn/10 text-qn-warn' : 'text-qn-muted',
            )}
          >
            <Icon size={14} />
            {current.label}
            <ChevronDown size={13} />
          </button>
        </MenuTrigger>
        <MenuContent side="top" align="end" aria-label="访问模式">
          {options.map((option) => (
            <MenuItem
              key={option.mode}
              icon={mode === option.mode ? <Check size={14} /> : <span className="w-3.5" />}
              hint={option.hint}
              danger={Boolean(option.warning)}
              onSelect={() => {
                if (option.mode === mode) return
                if (option.warning) setConfirm(option.mode)
                else onChange(option.mode)
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
          width="max-w-md"
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={() => setConfirm(null)}>取消</button>
              <button
                type="button"
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                disabled={disabled}
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
