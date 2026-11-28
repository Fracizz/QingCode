import { useId, useRef, useState, type DragEvent } from 'react'
import { GripVertical, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { t } from '@qn/codex-client'
import { Checkbox, ErrorNote, IconButton, Modal } from '../../components/ui'
import { cn } from '../../lib/cn'
import { useComposerShortcuts, type ComposerShortcut } from '../composer/shortcuts'

const DRAG_TYPE = 'application/x-qingcode-composer-shortcut'
type Drop = { id: string; after: boolean }

export function ComposerShortcutsSetting() {
  const shortcuts = useComposerShortcuts((state) => state.shortcuts)
  const updateShortcuts = useComposerShortcuts((state) => state.updateShortcuts)
  const headingId = useId()
  const dragId = useRef<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [editing, setEditing] = useState<ComposerShortcut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editorTrigger = useRef<HTMLButtonElement>(null)

  const update = (change: Parameters<typeof updateShortcuts>[0]) => {
    const saved = updateShortcuts(change)
    setError(saved ? null : t('保存快捷标签失败'))
    return saved
  }

  const edit = (trigger: HTMLButtonElement, shortcut?: ComposerShortcut) => {
    editorTrigger.current = trigger
    setError(null)
    setEditing(shortcut ?? { id: '', name: '', text: '', send: false })
  }

  const move = (id: string, target: Drop) => update((current) => {
    const shortcut = current.find((item) => item.id === id)
    if (!shortcut || id === target.id) return current
    const reordered = current.filter((item) => item.id !== id)
    const anchor = reordered.findIndex((item) => item.id === target.id)
    if (anchor === -1) return current
    reordered.splice(anchor + Number(target.after), 0, shortcut)
    return reordered.every((item, index) => item === current[index]) ? current : reordered
  })

  const clearDrag = () => {
    dragId.current = null
    setDrop(null)
  }

  const locateDrop = (event: DragEvent<HTMLLIElement>, id: string): Drop | null => {
    if (!dragId.current || dragId.current === id || !event.dataTransfer.types.includes(DRAG_TYPE)) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return { id, after: event.clientY >= rect.top + rect.height / 2 }
  }

  return (
    <section aria-labelledby={headingId} className="border-b border-qn-border py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-ui-md font-medium text-qn-text">{t('输入框快捷标签')}</h3>
          <p className="mt-1 text-ui-sm leading-5 text-qn-muted">{t('在主对话输入框上方显示常用文字。拖动调整顺序。')}</p>
        </div>
        <button type="button" className="qn-button-subtle flex shrink-0 items-center gap-1.5" onClick={(event) => edit(event.currentTarget)}>
          <Plus size={14} aria-hidden />{t('添加')}
        </button>
      </div>
      {!editing && <ErrorNote message={error} onClose={() => setError(null)} />}
      {shortcuts.length > 0 && (
        <ul className="mt-3 divide-y divide-qn-border rounded-lg border border-qn-border">
          {shortcuts.map((shortcut, index) => (
            <li
              key={shortcut.id}
              className="relative flex items-center gap-2 px-2 py-2"
              onDragOver={(event) => {
                const target = locateDrop(event, shortcut.id)
                if (target) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }
                setDrop((current) => current?.id === target?.id && current?.after === target?.after ? current : target)
              }}
              onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                setDrop((current) => current?.id === shortcut.id ? null : current)
              }}
              onDrop={(event) => {
                const target = locateDrop(event, shortcut.id)
                if (target && dragId.current && event.dataTransfer.getData(DRAG_TYPE) === dragId.current) {
                  event.preventDefault()
                  move(dragId.current, target)
                }
                clearDrag()
              }}
            >
              {drop?.id === shortcut.id && <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-qn-accent', drop.after ? 'bottom-0' : 'top-0')} />}
              <IconButton
                label={t('拖动排序 {name}', { name: shortcut.name })}
                title={t('拖动排序，或按 Alt+↑/↓')}
                tooltip={false}
                size="sm"
                className="cursor-grab active:cursor-grabbing"
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                draggable={shortcuts.length > 1}
                onDragStart={(event) => {
                  dragId.current = shortcut.id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(DRAG_TYPE, shortcut.id)
                }}
                onDragEnd={clearDrag}
                onKeyDown={(event) => {
                  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                  const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
                  const anchor = shortcuts[index + direction]
                  if (!direction || !anchor) return
                  event.preventDefault()
                  move(shortcut.id, { id: anchor.id, after: direction > 0 })
                }}
              >
                <GripVertical size={15} aria-hidden />
              </IconButton>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-ui font-medium text-qn-text">
                  <span className="truncate" title={shortcut.name}>{shortcut.name}</span>
                  {shortcut.send && <Send size={13} className="shrink-0 text-qn-muted" aria-label={t('一键发送')} />}
                </div>
                <p className="truncate text-ui-sm text-qn-muted">{shortcut.text}</p>
              </div>
              <IconButton label={t('编辑快捷标签 {name}', { name: shortcut.name })} size="sm" onClick={(event) => edit(event.currentTarget, shortcut)}>
                <Pencil size={14} aria-hidden />
              </IconButton>
              <IconButton label={t('删除快捷标签 {name}', { name: shortcut.name })} size="sm" danger onClick={() => update((current) => current.filter((item) => item.id !== shortcut.id))}>
                <Trash2 size={14} aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ShortcutEditor
          shortcut={editing}
          error={error}
          onClose={() => setEditing(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            editorTrigger.current?.focus()
          }}
          onSave={(fields) => {
            const next = { ...fields, id: editing.id || globalThis.crypto.randomUUID() }
            if (update((current) => editing.id ? current.map((item) => item.id === editing.id ? next : item) : [...current, next])) {
              setEditing(null)
            }
          }}
        />
      )}
    </section>
  )
}

function ShortcutEditor({ shortcut, error, onClose, onCloseAutoFocus, onSave }: {
  shortcut: ComposerShortcut
  error: string | null
  onClose: () => void
  onCloseAutoFocus: (event: Event) => void
  onSave: (shortcut: Omit<ComposerShortcut, 'id'>) => void
}) {
  const [name, setName] = useState(shortcut.name)
  const [text, setText] = useState(shortcut.text)
  const [send, setSend] = useState(shortcut.send)
  const formId = useId()

  return (
    <Modal
      title={shortcut.id ? t('编辑快捷标签') : t('添加快捷标签')}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" className="qn-button-subtle" onClick={onClose}>{t('取消')}</button>
          <button type="submit" form={formId} className="qn-button disabled:opacity-40" disabled={!name.trim() || !text.trim()}>{t('保存')}</button>
        </div>
      )}
    >
      <form id={formId} className="space-y-3" onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() && text.trim()) onSave({ name: name.trim(), text, send })
      }}>
        <label className="block text-qn-text">
          {t('显示名称')}
          <input className="qn-input mt-1" value={name} required onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block text-qn-text">
          {t('填入的文字')}
          <textarea className="qn-input qn-scroll mt-1 resize-y" rows={4} value={text} required onChange={(event) => setText(event.target.value)} />
        </label>
        <Checkbox checked={send} onChange={setSend}>{t('一键发送')}</Checkbox>
        <p className="text-ui-sm text-qn-muted">{t('草稿为空时发送，运行中加入队列。已有草稿时只填入文字。')}</p>
        <ErrorNote message={error} />
      </form>
    </Modal>
  )
}
