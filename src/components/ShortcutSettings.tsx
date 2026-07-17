import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  isShortcutInputTarget,
  RESERVED_SHORTCUTS,
  shortcutFromKeyboardEvent,
  type ShortcutCommand,
} from '../lib/shortcuts'
import { useShortcutStore } from '../store/shortcutStore'
import { useI18n } from '../lib/i18n'

const COMMANDS: { id: ShortcutCommand; label: string; description: string }[] = [
  {
    id: 'searchAllProjects',
    label: '打开搜索',
    description: '打开搜索面板，默认在当前项目中搜索文件与内容。',
  },
  {
    id: 'toggleTerminal',
    label: '切换终端',
    description: '显示或隐藏终端面板。',
  },
  {
    id: 'openSettings',
    label: '打开设置',
    description: '打开设置面板。',
  },
]

export default function ShortcutSettings() {
  const { t } = useI18n()
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const setShortcut = useShortcutStore(s => s.setShortcut)
  const resetShortcuts = useShortcutStore(s => s.resetShortcuts)
  const [capturing, setCapturing] = useState<ShortcutCommand | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const captureShortcut = (event: ReactKeyboardEvent<HTMLInputElement>, command: ShortcutCommand) => {
    if (isShortcutInputTarget(event.target) && event.key === 'Escape') {
      setCapturing(null)
      return
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    event.preventDefault()
    event.stopPropagation()
    if (!shortcut) {
      setMessage(t('请输入 Ctrl、Alt、Shift 或 Meta 加按键的组合。'))
      return
    }
    if (RESERVED_SHORTCUTS.has(shortcut)) {
      setMessage(t('该按键组合已由编辑器或开发工具使用。'))
      return
    }
    const conflict = COMMANDS.find(item => item.id !== command && shortcuts[item.id] === shortcut)
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
      <p className="text-xs text-fg-muted">{t('点击输入框后按新的组合键。')}</p>
      {COMMANDS.map(command => (
        <label key={command.id} className="flex items-center gap-3 rounded border border-border bg-bg/40 px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-fg">{t(command.label)}</span>
            <span className="mt-0.5 block text-[11px] text-fg-muted">{t(command.description)}</span>
          </span>
          <input
            readOnly
            value={shortcuts[command.id]}
            onFocus={() => {
              setCapturing(command.id)
              setMessage(null)
            }}
            onBlur={() => setCapturing(current => current === command.id ? null : current)}
            onKeyDown={event => captureShortcut(event, command.id)}
            aria-label={t(command.label)}
            className={`w-32 rounded border bg-bg-deep px-2 py-1 text-center font-mono text-[12px] outline-none ${
              capturing === command.id ? 'border-accent text-fg' : 'border-border-strong text-fg-muted'
            }`}
          />
        </label>
      ))}
      {message && <p className="text-xs text-danger">{message}</p>}
      <button
        type="button"
        onClick={() => {
          resetShortcuts()
          setCapturing(null)
          setMessage(null)
        }}
        className="inline-flex w-fit items-center gap-1 rounded px-2 py-1 text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <RotateCcw size={13} /> {t('恢复默认快捷键')}
      </button>
    </div>
  )
}
