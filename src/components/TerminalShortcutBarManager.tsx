import { useId, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import {
  canonicalizeShortcut,
  isReservedShortcut,
  isShortcutBound,
  shortcutFromKeyboardEvent,
} from '../lib/shortcuts'
import { SHORTCUT_COMMANDS } from '../lib/shortcutSettings'
import {
  CUSTOM_KEY_LIMIT,
  CUSTOM_KEY_NAME_LIMIT,
  CUSTOM_KEY_TEXT_LIMIT,
  builtinKeyInfo,
  customKeyDetail,
  customKeyLabel,
  customShortcutConflict,
  findCustomKey,
  isDefaultShortcutLayout,
  newCustomKeyId,
  normalizeCustomKey,
  type TerminalCustomKey,
} from '../lib/terminal/terminalShortcutBar'
import { confirmDialog } from '../store/confirmStore'
import { useShortcutStore } from '../store/shortcutStore'
import { useTerminalShortcutBarStore } from '../store/terminalShortcutBarStore'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'

type Draft = { id: string | null; name: string; text: string; enter: boolean; shortcut: string }
type DropTarget = { key: string; position: 'before' | 'after' }

const EMPTY_DRAFT: Draft = { id: null, name: '', text: '', enter: true, shortcut: '' }

/**
 * 快捷键栏管理弹窗（全局挂载，由设置页、栏的「⋯」菜单、命令面板打开）：
 * 显示开关、拖拽 / 按钮排序、隐藏到「⋯」、删除 / 加回内置键（含全部删除）、自定义键（子弹窗编辑，含终端内快捷键）。
 */
export default function TerminalShortcutBarManager() {
  const open = useTerminalShortcutBarStore(s => s.managerOpen)
  return open ? <ManagerDialog /> : null
}

function ManagerDialog() {
  const { t } = useI18n()
  const state = useTerminalShortcutBarStore()
  const appShortcuts = useShortcutStore(s => s.shortcuts)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shortcutHint, setShortcutHint] = useState<string | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const titleId = useId()
  const managerTitleId = useId()
  const shortcutInputRef = useRef<HTMLInputElement>(null)
  const layout = { order: state.order, hidden: state.hidden, custom: state.custom }

  const keyName = (key: string) => {
    const def = findCustomKey(layout, key)
    if (def) return def.name || def.text
    const info = builtinKeyInfo(key)
    return info ? t(info.name) : key
  }

  const openDraft = (def: TerminalCustomKey | null) => {
    setError(null)
    setShortcutHint(null)
    setDraft(def ? { ...def } : { ...EMPTY_DRAFT })
  }

  const saveDraft = () => {
    if (!draft) return
    const def = normalizeCustomKey({ ...draft, id: draft.id ?? newCustomKeyId(layout) })
    if (!def) {
      setError(t('请输入要发送的文本，不能包含换行。'))
      return
    }
    if (!draft.id && state.custom.length >= CUSTOM_KEY_LIMIT) {
      setError(t('自定义键最多 {n} 个。', { n: CUSTOM_KEY_LIMIT }))
      return
    }
    state.saveCustomKey(def)
    setDraft(null)
  }

  const builtinCount = state.order.filter(key => builtinKeyInfo(key)).length

  const removeAllBuiltins = async () => {
    if (!await confirmDialog({
      title: t('删除全部内置键'),
      message: t('删除全部 {n} 个内置键？', { n: builtinCount }),
      detail: t('自定义键保留；删除后可单独加回，或点「恢复默认」。'),
      confirmLabel: t('删除'),
      kind: 'danger',
    })) return
    state.removeAllBuiltinKeys()
  }

  const removeKey = async (def: TerminalCustomKey) => {
    if (!await confirmDialog({
      title: t('删除自定义键'),
      message: t('删除自定义键「{name}」？', { name: customKeyLabel(def) }),
      detail: t('删除后可以再次添加。'),
      confirmLabel: t('删除'),
      kind: 'danger',
    })) return
    state.removeCustomKey(def.id)
  }

  /** Esc：焦点在快捷键录入框时只退出录入，否则关闭弹窗。 */
  const dismissDraft = () => {
    const input = shortcutInputRef.current
    if (input && document.activeElement === input) {
      setShortcutHint(null)
      input.blur()
      return
    }
    setDraft(null)
  }

  const dropPosition = (event: ReactDragEvent<HTMLElement>): DropTarget['position'] => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, key: string) => {
    if (!dragged || dragged === key) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const position = dropPosition(event)
    setDropTarget(current => (current?.key === key && current.position === position ? current : { key, position }))
  }

  const clearDrag = () => {
    setDragged(null)
    setDropTarget(null)
  }

  const captureShortcut = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!draft) return
    if (event.key === 'Tab') return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setShortcutHint(null)
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      setDraft({ ...draft, shortcut: '' })
      setShortcutHint(null)
      return
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    if (!shortcut) {
      setShortcutHint(t('请输入 Ctrl、Alt、Shift 或 Meta 加按键的组合；或按 Backspace 清空。'))
      return
    }
    if (isReservedShortcut(shortcut)) {
      setShortcutHint(t('该按键组合已由编辑器或开发工具使用。'))
      return
    }
    const app = SHORTCUT_COMMANDS.find(
      item => isShortcutBound(appShortcuts[item.id]) && canonicalizeShortcut(appShortcuts[item.id]) === shortcut,
    )
    if (app) {
      setShortcutHint(t('该快捷键已用于「{name}」。', { name: t(app.label) }))
      return
    }
    const conflict = customShortcutConflict(layout, draft.id ?? '', shortcut)
    if (conflict?.kind === 'terminal') {
      setShortcutHint(t('该按键组合由终端使用（复制、粘贴、中断、换行或查找）。'))
      return
    }
    if (conflict?.kind === 'custom') {
      setShortcutHint(t('该快捷键已用于「{name}」。', { name: customKeyLabel(conflict.key) }))
      return
    }
    setDraft({ ...draft, shortcut })
    setShortcutHint(null)
  }

  const fieldLabel = 'flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted'
  const editor = draft && (
    <ModalOverlay onDismiss={dismissDraft}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-content-enter relative w-full max-w-[480px] rounded-lg border border-border-strong bg-bg-elevated shadow-elevation-3"
        onSubmit={event => {
          event.preventDefault()
          saveDraft()
        }}
      >
        <div className="flex flex-col gap-3.5 px-5 pt-5 pb-4">
          <h2 id={titleId} className="text-ui-lg font-semibold text-fg">
            {draft.id ? t('编辑自定义键') : t('添加自定义键')}
          </h2>
          <label className={fieldLabel}>
            {t('发送的文本')}
            <input
              data-modal-autofocus
              value={draft.text}
              maxLength={CUSTOM_KEY_TEXT_LIMIT}
              onChange={event => {
                setDraft({ ...draft, text: event.target.value })
                if (error) setError(null)
              }}
              placeholder={t('例如 /compact 或 git status')}
              className={`modal-field-input font-mono ${error ? 'modal-field-input--invalid' : ''}`}
              aria-invalid={error ? true : undefined}
              spellCheck={false}
            />
            {error && <span className="text-danger">{error}</span>}
          </label>
          <label className={fieldLabel}>
            {t('按钮名称（可选）')}
            <input
              value={draft.name}
              maxLength={CUSTOM_KEY_NAME_LIMIT}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
              placeholder={t('留空时显示发送的文本')}
              className="modal-field-input"
            />
          </label>
          <label className={fieldLabel}>
            {t('终端内快捷键（可选）')}
            <input
              ref={shortcutInputRef}
              readOnly
              value={draft.shortcut}
              onKeyDown={captureShortcut}
              placeholder={t('点击后按组合键，Backspace 清空')}
              className="modal-field-input font-mono"
            />
            {shortcutHint && <span className="text-warn">{shortcutHint}</span>}
          </label>
          <label className="flex items-center gap-2 text-ui-sm text-fg">
            <input
              type="checkbox"
              checked={draft.enter}
              onChange={event => setDraft({ ...draft, enter: event.target.checked })}
            />
            {t('发送后回车')}
          </label>
        </div>
        <div className="flex justify-end gap-2 rounded-b-lg border-t border-border bg-bg-deep/20 px-5 py-3.5">
          <button
            type="button"
            className="rounded-md border border-border-strong bg-bg px-3.5 py-1.5 text-ui font-medium text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
            onClick={() => setDraft(null)}
          >
            {t('取消')}
          </button>
          <button
            type="submit"
            className="rounded-md bg-action px-3.5 py-1.5 text-ui font-medium text-on-action shadow-sm transition-all duration-150 hover:bg-action/90"
          >
            {draft.id ? t('保存') : t('添加')}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )

  return (
    <ModalOverlay onDismiss={state.closeManager}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={managerTitleId}
        className="ui-font-scaled modal-content-enter relative flex max-h-[85vh] w-full max-w-[720px] flex-col rounded-lg border border-border-strong bg-bg-elevated shadow-elevation-3"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <h2 id={managerTitleId} className="text-ui-lg font-semibold text-fg">{t('管理快捷键栏')}</h2>
          <label className="flex items-center gap-1.5 text-ui-sm text-fg-muted">
            <input
              type="checkbox"
              checked={!state.collapsed}
              onChange={event => state.setCollapsed(!event.target.checked)}
            />
            {t('在终端底部显示')}
          </label>
          <Tooltip label={t('关闭')} side="bottom">
            <button type="button" aria-label={t('关闭')} className="terminal-profile-icon ml-auto" onClick={state.closeManager}>
              <X size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="terminal-profiles min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-ui-sm leading-relaxed text-fg-muted">
            {t('点击按钮直接发送到所在终端。拖动行可调整顺序；取消勾选的键收进栏右侧的「⋯」菜单；栏宽不够时，排在后面的键也会收进去。自定义键可发送一段文本（如 /compact），并可绑定只在终端内生效的快捷键。')}
          </p>
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="terminal-profile-add hover:!text-danger"
              disabled={builtinCount === 0}
              onClick={() => void removeAllBuiltins()}
            >
              <Trash2 size={13} />{t('删除全部内置键')}
            </button>
            <button
              type="button"
              className="terminal-profile-add"
              disabled={isDefaultShortcutLayout(layout)}
              onClick={() => state.resetLayout()}
            >
              <RotateCcw size={13} />{t('恢复默认')}
            </button>
            <button
              type="button"
              className="terminal-profile-add"
              disabled={state.custom.length >= CUSTOM_KEY_LIMIT}
              onClick={() => openDraft(null)}
            >
              <Plus size={13} />{t('添加自定义键')}
            </button>
          </div>
          {state.order.length === 0 && (
            <p className="rounded border border-dashed border-border px-3 py-6 text-center text-ui-sm text-fg-muted">
              {t('快捷键栏是空的。可以添加自定义键，或从下方加回内置键。')}
            </p>
          )}
          <div className={`overflow-hidden rounded border border-border ${state.order.length === 0 ? 'hidden' : ''}`}>
            {state.order.map((key, index) => {
              const def = findCustomKey(layout, key)
              const name = keyName(key)
              const visible = !state.hidden.includes(key)
              const info = builtinKeyInfo(key)
              return (
                <div
                  key={key}
                  data-shortcut-row={key}
                  draggable
                  className={`terminal-profile-row relative border-b border-border last:border-b-0 ${dragged === key ? 'opacity-40' : ''}`}
                  onDragStart={event => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', key)
                    setDragged(key)
                  }}
                  onDragOver={event => handleDragOver(event, key)}
                  onDrop={event => {
                    event.preventDefault()
                    if (dragged && dragged !== key) state.reorder(dragged, key, dropPosition(event))
                    clearDrag()
                  }}
                  onDragEnd={clearDrag}
                >
                  {dropTarget?.key === key && dragged !== key && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded bg-accent ${dropTarget.position === 'before' ? 'top-0' : 'bottom-0'}`}
                    />
                  )}
                  <div className="terminal-profile-summary">
                    <GripVertical size={13} aria-hidden className="ml-1 shrink-0 cursor-grab text-fg-dim active:cursor-grabbing" />
                    <label className="terminal-profile-toggle cursor-pointer">
                      <input
                        type="checkbox"
                        checked={visible}
                        aria-label={t('在快捷键栏显示 {name}', { name })}
                        onChange={() => state.toggleHidden(key)}
                      />
                      <span className="terminal-shortcut-key shrink-0">{def ? customKeyLabel(def) : t(info?.label ?? key)}</span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate">{name}</span>
                        <span className="mt-0.5 block truncate text-ui-sm text-fg-muted">
                          {def
                            ? <><span className="font-mono">{customKeyDetail(def)}</span>{def.shortcut && <><span className="mx-1.5">·</span>{def.shortcut}</>}</>
                            : visible ? t('内置') : t('内置 · 在「⋯」中')}
                        </span>
                      </span>
                    </label>
                    <div className="terminal-profile-actions">
                      {def && (
                        <Tooltip label={t('编辑')} side="top">
                          <button type="button" aria-label={t('编辑 {name}', { name })} className="terminal-profile-icon" onClick={() => openDraft(def)}>
                            <Pencil size={13} />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip label={def ? t('删除') : t('删除（可在下方加回）')} side="top">
                        <button
                          type="button"
                          aria-label={t('删除 {name}', { name })}
                          className="terminal-profile-icon hover:!text-danger"
                          onClick={() => (def ? void removeKey(def) : state.removeBuiltinKey(key))}
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('上移')} side="top">
                        <button type="button" aria-label={t('上移 {name}', { name })} className="terminal-profile-icon disabled:opacity-30" disabled={index === 0} onClick={() => state.move(key, -1)}>
                          <ArrowUp size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('下移')} side="top">
                        <button type="button" aria-label={t('下移 {name}', { name })} className="terminal-profile-icon disabled:opacity-30" disabled={index === state.order.length - 1} onClick={() => state.move(key, 1)}>
                          <ArrowDown size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {state.removed.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm text-fg-muted" data-shortcut-removed="">
              <span>{t('已删除的内置键：')}</span>
              {state.removed.map(key => {
                const info = builtinKeyInfo(key)
                const name = info ? t(info.name) : key
                return (
                  <Tooltip key={key} label={t('加回 {name}', { name })} side="top">
                    <button
                      type="button"
                      aria-label={t('加回 {name}', { name })}
                      className="terminal-profile-add"
                      onClick={() => state.restoreBuiltinKey(key)}
                    >
                      <Plus size={12} />{t(info?.label ?? key)}
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {editor}
    </ModalOverlay>
  )
}
