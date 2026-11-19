import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
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
import Tooltip from './Tooltip'

type Draft = { id: string | null; name: string; text: string; enter: boolean; shortcut: string }

const EMPTY_DRAFT: Draft = { id: null, name: '', text: '', enter: true, shortcut: '' }

/** 设置 → 终端 → 快捷键栏：显示开关、排序、隐藏到「⋯」、自定义键（含终端内快捷键）。 */
export default function TerminalShortcutBarSettings() {
  const { t } = useI18n()
  const state = useTerminalShortcutBarStore()
  const appShortcuts = useShortcutStore(s => s.shortcuts)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shortcutHint, setShortcutHint] = useState<string | null>(null)
  const formId = useId()
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

  const removeKey = async (def: TerminalCustomKey) => {
    if (!await confirmDialog({
      title: t('删除自定义键'),
      message: t('删除自定义键「{name}」？', { name: customKeyLabel(def) }),
      detail: t('删除后可以再次添加。'),
      confirmLabel: t('删除'),
      kind: 'danger',
    })) return
    state.removeCustomKey(def.id)
    if (draft?.id === def.id) setDraft(null)
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

  const editor = draft && (
    <form
      id={formId}
      className="terminal-profile-editor"
      onSubmit={event => {
        event.preventDefault()
        saveDraft()
      }}
    >
      <label className="flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted">
        {t('发送的文本')}
        <input
          autoFocus
          value={draft.text}
          maxLength={CUSTOM_KEY_TEXT_LIMIT}
          onChange={event => setDraft({ ...draft, text: event.target.value })}
          placeholder={t('例如 /compact 或 git status')}
          className="setting-control !min-w-0 !w-full !max-w-none font-mono"
          spellCheck={false}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted">
        {t('按钮名称（可选）')}
        <input
          value={draft.name}
          maxLength={CUSTOM_KEY_NAME_LIMIT}
          onChange={event => setDraft({ ...draft, name: event.target.value })}
          placeholder={t('留空时显示发送的文本')}
          className="setting-control !min-w-0 !w-full !max-w-none"
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-ui-sm text-fg-muted">
        {t('终端内快捷键（可选）')}
        <input
          readOnly
          value={draft.shortcut}
          onKeyDown={captureShortcut}
          placeholder={t('点击后按组合键，Backspace 清空')}
          className="setting-control !min-w-0 !w-full !max-w-none font-mono"
        />
        {shortcutHint && <span className="text-warn">{shortcutHint}</span>}
      </label>
      <label className="flex min-w-0 items-center gap-2 self-end text-ui-sm text-fg">
        <input
          type="checkbox"
          checked={draft.enter}
          onChange={event => setDraft({ ...draft, enter: event.target.checked })}
        />
        {t('发送后回车')}
      </label>
      {error && <p className="terminal-profile-command text-ui-sm text-danger">{error}</p>}
      <div className="terminal-profile-command flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="terminal-profile-add" onClick={() => setDraft(null)}>
          {t('取消')}
        </button>
        <button type="submit" className="terminal-profile-add !border-accent text-fg">
          {draft.id ? t('保存') : t('添加')}
        </button>
      </div>
    </form>
  )

  return (
    <div className="terminal-profiles min-w-0" data-settings-anchor="terminal-shortcut-bar" aria-label={t('快捷键栏')}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-ui font-medium">{t('快捷键栏')}</h3>
          <label className="flex items-center gap-1.5 text-ui-sm text-fg-muted">
            <input
              type="checkbox"
              checked={!state.collapsed}
              onChange={event => state.setCollapsed(!event.target.checked)}
            />
            {t('在终端底部显示')}
          </label>
        </div>
        <div className="flex items-center gap-2">
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
      </div>
      <p className="mb-3 text-ui-sm leading-relaxed text-fg-muted">
        {t('点击按钮直接发送到所在终端。取消勾选的键收进栏右侧的「⋯」菜单；栏宽不够时，排在后面的键也会收进去。自定义键可发送一段文本（如 /compact），并可绑定只在终端内生效的快捷键。')}
      </p>
      {draft && !draft.id && (
        <div className="mb-3 overflow-hidden rounded border border-border">{editor}</div>
      )}
      <div className="overflow-hidden rounded border border-border">
        {state.order.map((key, index) => {
          const def = findCustomKey(layout, key)
          const name = keyName(key)
          const visible = !state.hidden.includes(key)
          const info = builtinKeyInfo(key)
          return (
            <div key={key} data-shortcut-row={key} className="terminal-profile-row border-b border-border last:border-b-0">
              <div className="terminal-profile-summary">
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
                  {def && <>
                    <Tooltip label={t('编辑')} side="top">
                      <button type="button" aria-label={t('编辑 {name}', { name })} className="terminal-profile-icon" onClick={() => openDraft(draft?.id === def.id ? null : def)}>
                        <Pencil size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label={t('删除')} side="top">
                      <button type="button" aria-label={t('删除 {name}', { name })} className="terminal-profile-icon hover:!text-danger" onClick={() => void removeKey(def)}>
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  </>}
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
              {def && draft?.id === def.id && editor}
            </div>
          )
        })}
      </div>
    </div>
  )
}
