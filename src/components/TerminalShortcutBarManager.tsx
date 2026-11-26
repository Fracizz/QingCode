import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useVerticalPointerReorder } from '../hooks/useVerticalPointerReorder'
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
  customKeyDetail,
  customKeyLabel,
  customShortcutConflict,
  findCustomKey,
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

const EMPTY_DRAFT: Draft = { id: null, name: '', text: '', enter: true, shortcut: '' }

/**
 * 快捷键栏管理弹窗（全局挂载，由设置页、栏的「⋯」菜单、命令面板打开）：
 * 显示开关、拖拽 / 按钮排序、隐藏到「⋯」、自定义键（子弹窗编辑，含终端内快捷键）。电脑端不提供内置键。
 */
export default function TerminalShortcutBarManager() {
  const open = useTerminalShortcutBarStore(s => s.managerOpen)
  return open ? <ManagerDialog /> : null
}

function ManagerDialog() {
  const { t } = useI18n()
  const state = useTerminalShortcutBarStore()
  const [editing, setEditing] = useState<TerminalCustomKey | 'new' | null>(null)
  const managerTitleId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const layout = { order: state.order, hidden: state.hidden, custom: state.custom }

  const openDraft = (def: TerminalCustomKey | null) => setEditing(def ?? 'new')

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

  // Tauri 接管原生拖放后 WebView2 收不到 dragover / drop（光标显示禁止、放不下），改用指针拖动。
  // 落点按纵坐标取最近一行，指针越过首行顶边时仍落在首行之前。
  const { draggedId: dragged, drop: dropTarget, start: startDrag } = useVerticalPointerReorder({
    targetSelector: '[data-shortcut-row]',
    targetIdOf: element => element.dataset.shortcutRow,
    ignoreSelector: 'button, input',
    listRef,
    canDrop: () => true,
    onDrop: (source, drop) => state.reorder(source, drop.id, drop.position),
  })

  return (
    <ModalOverlay onDismiss={state.closeManager}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={managerTitleId}
        className="modal-panel modal-lg ui-font-scaled modal-content-enter flex max-h-[85vh] flex-col"
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
          <Tooltip label={t('关闭')} side="bottom" wrapperClassName="ml-auto inline-flex shrink-0">
            <button type="button" aria-label={t('关闭')} className="terminal-profile-icon" onClick={state.closeManager}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <div
          ref={listRef}
          className="terminal-profiles min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          <p className="mb-3 text-ui-sm leading-relaxed text-fg-muted">
            {t('点击按钮直接发送到所在终端。拖动行可调整顺序；取消勾选的键收进栏右侧的「⋯」菜单；栏宽不够时，排在后面的键也会收进去。自定义键可发送一段文本（如 /compact），并可绑定只在终端内生效的快捷键。')}
          </p>
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="terminal-profile-add"
              disabled={state.custom.length >= CUSTOM_KEY_LIMIT}
              onClick={() => openDraft(null)}
            >
              <Plus size={14} />{t('添加自定义键')}
            </button>
          </div>
          {state.order.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-ui-sm text-fg-muted">
              {t('快捷键栏是空的。点击「添加自定义键」添加要发送的文本，如 /compact。')}
            </p>
          )}
          <div className={`overflow-hidden rounded-md border border-border ${state.order.length === 0 ? 'hidden' : ''}`}>
            {state.order.map((key, index) => {
              const def = findCustomKey(layout, key)
              if (!def) return null
              const name = def.name || def.text
              const visible = !state.hidden.includes(key)
              const chip = customKeyLabel(def)
              return (
                <div
                  key={key}
                  data-shortcut-row={key}
                  className={`terminal-profile-row relative cursor-grab border-b border-border last:border-b-0 hover:bg-bg-hover ${dragged === key ? 'cursor-grabbing opacity-40' : ''}`}
                  onPointerDown={event => startDrag(event, key)}
                >
                  {dropTarget?.id === key && dragged !== key && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded bg-accent ${dropTarget.position === 'before' ? 'top-0' : 'bottom-0'}`}
                    />
                  )}
                  <div className="terminal-profile-summary">
                    <GripVertical size={14} aria-hidden className="ml-1 shrink-0 text-fg-dim" />
                    {/* 整行悬停高亮（见 className），label 自身不再单独出现半截底色 */}
                    <label className="terminal-profile-toggle hover:!bg-transparent">
                      <input
                        type="checkbox"
                        checked={visible}
                        aria-label={t('在快捷键栏显示 {name}', { name })}
                        onChange={() => state.toggleHidden(key)}
                      />
                      {/* 固定宽度的按钮预览列，保证后面的说明文字左对齐 */}
                      <span className="flex w-28 shrink-0">
                        <span className={`terminal-shortcut-key !max-w-full truncate ${visible ? '' : 'opacity-50'}`}>{chip}</span>
                      </span>
                      <span className="flex min-w-0 flex-1 items-baseline gap-2 truncate text-left">
                        {name !== chip && <span className="shrink-0 truncate">{name}</span>}
                        <span className="min-w-0 truncate text-ui-sm text-fg-muted">
                          <span className="font-mono">{customKeyDetail(def)}</span>
                          {def.shortcut && <><span className="mx-1.5">·</span>{def.shortcut}</>}
                        </span>
                      </span>
                    </label>
                    <div className="terminal-profile-actions">
                      <Tooltip label={t('编辑')} side="top">
                        <button type="button" aria-label={t('编辑 {name}', { name })} className="terminal-profile-icon" onClick={() => openDraft(def)}>
                          <Pencil size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('删除')} side="top">
                        <button
                          type="button"
                          aria-label={t('删除 {name}', { name })}
                          className="terminal-profile-icon hover:!text-danger"
                          onClick={() => void removeKey(def)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('上移')} side="top">
                        <button type="button" aria-label={t('上移 {name}', { name })} className="terminal-profile-icon disabled:opacity-30" disabled={index === 0} onClick={() => state.move(key, -1)}>
                          <ArrowUp size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('下移')} side="top">
                        <button type="button" aria-label={t('下移 {name}', { name })} className="terminal-profile-icon disabled:opacity-30" disabled={index === state.order.length - 1} onClick={() => state.move(key, 1)}>
                          <ArrowDown size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {editing && <CustomKeyEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </ModalOverlay>
  )
}

/** 自定义键编辑子弹窗：草稿状态放在这里，输入时只重渲染本弹窗，不连带重渲染整个管理列表。 */
function CustomKeyEditor({ initial, onClose }: { initial: TerminalCustomKey | null; onClose: () => void }) {
  const { t } = useI18n()
  const order = useTerminalShortcutBarStore(s => s.order)
  const hidden = useTerminalShortcutBarStore(s => s.hidden)
  const custom = useTerminalShortcutBarStore(s => s.custom)
  const saveCustomKey = useTerminalShortcutBarStore(s => s.saveCustomKey)
  const appShortcuts = useShortcutStore(s => s.shortcuts)
  const [draft, setDraft] = useState<Draft>(() => (initial ? { ...initial } : { ...EMPTY_DRAFT }))
  const [error, setError] = useState<string | null>(null)
  const [shortcutHint, setShortcutHint] = useState<string | null>(null)
  const titleId = useId()
  const shortcutInputRef = useRef<HTMLInputElement>(null)
  const layout = { order, hidden, custom }

  const saveDraft = () => {
    const def = normalizeCustomKey({ ...draft, id: draft.id ?? newCustomKeyId(layout) })
    if (!def) {
      setError(t('请输入要发送的文本，不能包含换行。'))
      return
    }
    if (!draft.id && custom.length >= CUSTOM_KEY_LIMIT) {
      setError(t('自定义键最多 {n} 个。', { n: CUSTOM_KEY_LIMIT }))
      return
    }
    saveCustomKey(def)
    onClose()
  }

  /** Esc：焦点在快捷键录入框时只退出录入，否则关闭弹窗。 */
  const dismissDraft = () => {
    const input = shortcutInputRef.current
    if (input && document.activeElement === input) {
      setShortcutHint(null)
      input.blur()
      return
    }
    onClose()
  }

  const captureShortcut = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
  return (
    <ModalOverlay onDismiss={dismissDraft}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-panel modal-md modal-content-enter"
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
            {t('按钮名称（可选）')}
            <input
              data-modal-autofocus
              value={draft.name}
              maxLength={CUSTOM_KEY_NAME_LIMIT}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
              placeholder={t('留空时显示发送的文本')}
              className="modal-field-input"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className={fieldLabel}>
            {t('发送的文本')}
            <input
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
              autoComplete="off"
            />
            {error && <span className="text-danger">{error}</span>}
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
            className="btn btn-secondary"
            onClick={onClose}
          >
            {t('取消')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
          >
            {draft.id ? t('保存') : t('添加')}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}
