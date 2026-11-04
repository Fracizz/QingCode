import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  canonicalizeShortcut,
  isReservedShortcut,
  isShortcutBound,
  isShortcutInputTarget,
  shortcutFromKeyboardEvent,
  type ShortcutCommand,
} from '../lib/shortcuts'
import { useShortcutStore } from '../store/shortcutStore'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'
import { SHORTCUT_COMMANDS as COMMANDS, FIXED_SHORTCUTS } from '../lib/shortcutSettings'

export default function ShortcutSettings({ query = '' }: { query?: string }) {
  const { t } = useI18n()
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const setShortcut = useShortcutStore(s => s.setShortcut)
  const resetShortcuts = useShortcutStore(s => s.resetShortcuts)
  const q = query.trim().toLowerCase()
  const all = !q || ['快捷键', '键盘', '键盘快捷方式', 'shortcuts', 'keyboard'].some(term =>
    term.toLowerCase().includes(q) || t(term).toLowerCase().includes(q),
  )
  const matches = (...terms: string[]) => all || terms.some(term =>
    term.toLowerCase().includes(q) || t(term).toLowerCase().includes(q),
  )
  const commands = COMMANDS.filter(command => matches(command.label, command.description, shortcuts[command.id]))
  const fixedShortcuts = FIXED_SHORTCUTS.filter(item => matches(item.label, item.description, item.shortcut))
  const [capturing, setCapturing] = useState<ShortcutCommand | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const captureShortcut = (event: ReactKeyboardEvent<HTMLInputElement>, command: ShortcutCommand) => {
    if (isShortcutInputTarget(event.target) && event.key === 'Escape') {
      setCapturing(null)
      setMessage(null)
      return
    }

    // Clear / unbind: Backspace or Delete while capturing.
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      event.stopPropagation()
      setShortcut(command, '')
      setCapturing(null)
      setMessage(null)
      return
    }

    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    event.preventDefault()
    event.stopPropagation()
    if (!shortcut) {
      setMessage(t('请输入 Ctrl、Alt、Shift 或 Meta 加按键的组合；或按 Backspace 清空。'))
      return
    }
    if (isReservedShortcut(shortcut)) {
      setMessage(t('该按键组合已由编辑器或开发工具使用。'))
      return
    }
    const conflict = COMMANDS.find(
      item =>
        item.id !== command &&
        isShortcutBound(shortcuts[item.id]) &&
        canonicalizeShortcut(shortcuts[item.id]) === canonicalizeShortcut(shortcut),
    )
    if (conflict) {
      setMessage(t('该快捷键已用于「{name}」。', { name: t(conflict.label) }))
      return
    }
    setShortcut(command, shortcut)
    setCapturing(null)
    setMessage(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui-sm text-fg-muted">
        {t('点击输入框后按新的组合键。按 Backspace 或 Delete 可清空（未绑定）。')}
      </p>
      {commands.map(command => {
        const bound = isShortcutBound(shortcuts[command.id])
        return (
          <label
            key={command.id}
            className="shortcut-setting-row flex min-w-0 flex-wrap items-center gap-3 rounded border border-border bg-bg/40 px-3 py-2"
          >
            <span className="min-w-0 flex-1 basis-56">
              <span className="block text-ui text-fg">{t(command.label)}</span>
              <span className="text-ui-sm mt-0.5 block text-fg-muted">{t(command.description)}</span>
            </span>
            <input
              readOnly
              value={bound ? shortcuts[command.id] : ''}
              placeholder={t('未绑定')}
              onFocus={() => {
                setCapturing(command.id)
                setMessage(null)
              }}
              onBlur={() => setCapturing(current => (current === command.id ? null : current))}
              onKeyDown={event => captureShortcut(event, command.id)}
              aria-label={t(command.label)}
              className={`w-[12em] max-w-full min-w-0 shrink-0 rounded border bg-bg-deep px-2 py-1 text-center font-mono text-ui-sm outline-none placeholder:text-fg-dim ${
                capturing === command.id
                  ? 'border-accent text-fg'
                  : bound
                    ? 'border-border-strong text-fg-muted'
                    : 'border-border text-fg-dim'
              }`}
            />
          </label>
        )
      })}

      {fixedShortcuts.length > 0 && <p className="pt-1 text-ui-sm text-fg-muted">{t('以下快捷键由编辑器保留，不可在此修改：')}</p>}
      {fixedShortcuts.map(item => (
        <div
          key={item.shortcut}
          className="shortcut-setting-row flex min-w-0 flex-wrap items-center gap-3 rounded border border-border/80 bg-bg/20 px-3 py-2"
        >
          <span className="min-w-0 flex-1 basis-56">
            <span className="block text-ui text-fg">{t(item.label)}</span>
            <span className="text-ui-sm mt-0.5 block text-fg-muted">{t(item.description)}</span>
          </span>
          <Tooltip label={t('不可修改')} side="left" wrapperClassName="min-w-0 max-w-full">
            <span className="inline-flex min-h-[30px] w-[12em] max-w-full items-center justify-center rounded border border-border bg-bg-deep px-2 font-mono text-ui-sm text-fg-dim break-words">
              {item.shortcut}
            </span>
          </Tooltip>
        </div>
      ))}

      {message && <p className="text-ui-sm text-danger">{message}</p>}
      <button
        type="button"
        onClick={() => {
          resetShortcuts()
          setCapturing(null)
          setMessage(null)
        }}
        className="inline-flex w-fit items-center gap-1 rounded px-2 py-1 text-ui-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <RotateCcw size={13} /> {t('恢复默认快捷键')}
      </button>
    </div>
  )
}
