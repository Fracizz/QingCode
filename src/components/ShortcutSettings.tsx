import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  canonicalizeShortcut,
  COPY_RELATIVE_PATH_SHORTCUT,
  isReservedShortcut,
  isShortcutBound,
  isShortcutInputTarget,
  shortcutFromKeyboardEvent,
  type ShortcutCommand,
} from '../lib/shortcuts'
import { useShortcutStore } from '../store/shortcutStore'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

const COMMANDS: { id: ShortcutCommand; label: string; description: string }[] = [
  {
    id: 'openCommandPalette',
    label: '打开命令面板',
    description: '打开命令面板，搜索并运行编辑器命令。',
  },
  {
    id: 'quickOpen',
    label: '快速打开文件',
    description: '按文件名模糊搜索并打开项目中的文件。',
  },
  {
    id: 'goToSymbolInEditor',
    label: '转到编辑器中的符号',
    description: '打开当前文件的符号列表，快速跳转到函数、类或标题。',
  },
  {
    id: 'goToDefinition',
    label: '转到定义',
    description:
      '跳转到光标处标识符的定义（启发式：同文件符号/变量与 import 路径）。也可用 Ctrl/Cmd+点击。',
  },
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
  {
    id: 'goToLine',
    label: '转到行',
    description: '跳转到当前文件中的指定行号。',
  },
  {
    id: 'navigateBack',
    label: '后退',
    description: '返回上一次编辑位置（打开文件、转到行、搜索跳转等）。',
  },
  {
    id: 'navigateForward',
    label: '前进',
    description: '前进到下一次编辑位置。',
  },
  {
    id: 'toggleMinimap',
    label: '切换小地图',
    description: '显示或隐藏编辑区右侧的代码小地图。',
  },
  {
    id: 'togglePanelLayout',
    label: '切换面板布局',
    description: '依次切换：经典 → 终端+编辑器 → 双终端+编辑器。标题栏可直接选择。',
  },
  {
    id: 'renameInExplorer',
    label: '资源管理器: 重命名',
    description: '在文件树中行内重命名当前选中的文件或文件夹。',
  },
  {
    id: 'findInTerminal',
    label: '终端: 查找',
    description: '在终端输出中查找文本（需焦点在终端内）。',
  },
  {
    id: 'clearTerminal',
    label: '终端: 清空',
    description: '清空当前终端缓冲区（需焦点在终端内）。',
  },
]

/** Editor-bound shortcuts shown as read-only (not remappable here). */
const FIXED_SHORTCUTS: { shortcut: string; label: string; description: string }[] = [
  {
    shortcut: 'Ctrl+S',
    label: '保存文件',
    description: '保存当前编辑器中的文件。',
  },
  {
    shortcut: 'Ctrl+Shift+C',
    label: '复制路径',
    description: '复制当前文件或选中项的完整路径。',
  },
  {
    shortcut: COPY_RELATIVE_PATH_SHORTCUT,
    label: '复制相对路径',
    description: '复制当前文件相对项目根目录的路径（POSIX 斜杠）。',
  },
  {
    shortcut: 'Alt+C',
    label: '复制为文件引用',
    description: '复制当前文件的引用（含行号范围），便于粘贴到对话或文档。',
  },
  {
    shortcut: 'Shift+Alt+F',
    label: '格式化文档',
    description: '使用 Prettier、rustfmt、shfmt、ruff/black 或 gofmt 格式化当前文件（需本机已安装对应工具）。',
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
      <p className="text-xs text-fg-muted">
        {t('点击输入框后按新的组合键。按 Backspace 或 Delete 可清空（未绑定）。')}
      </p>
      {COMMANDS.map(command => {
        const bound = isShortcutBound(shortcuts[command.id])
        return (
          <label
            key={command.id}
            className="flex items-center gap-3 rounded border border-border bg-bg/40 px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-fg">{t(command.label)}</span>
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
              className={`w-36 rounded border bg-bg-deep px-2 py-1 text-center font-mono text-[12px] outline-none placeholder:text-fg-dim ${
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

      <p className="pt-1 text-xs text-fg-muted">{t('以下快捷键由编辑器保留，不可在此修改：')}</p>
      {FIXED_SHORTCUTS.map(item => (
        <div
          key={item.shortcut}
          className="flex items-center gap-3 rounded border border-border/80 bg-bg/20 px-3 py-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-fg">{t(item.label)}</span>
            <span className="text-ui-sm mt-0.5 block text-fg-muted">{t(item.description)}</span>
          </span>
          <Tooltip label={t('不可修改')} side="left">
            <span className="inline-flex h-[30px] w-36 items-center justify-center rounded border border-border bg-bg-deep px-2 font-mono text-[12px] text-fg-dim">
              {item.shortcut}
            </span>
          </Tooltip>
        </div>
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
