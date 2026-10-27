import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauri } from '../lib/tauri'
import { Paperclip, X } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { translate } from '../lib/i18n'
import { copyToClipboard } from '../utils/fileReferences'
import { parseLocalFilePasteText } from '../lib/sshTerminalPaste'
import { useTerminalDraftStore } from '../store/terminalDraftStore'

export interface TerminalComposerProps {
  terminalId: string
  terminalName: string
  onClose: () => void
  onFill: (text: string) => boolean
  prepareClipboard: (event: globalThis.ClipboardEvent) => Promise<string | null>
  prepareFiles: (files: File[]) => Promise<string | null>
  prepareFilePaths: (paths: string[]) => Promise<string | null>
}

/** Portal overlay: opening/editing never changes the PTY's character grid. */
export default function TerminalComposer({
  terminalId,
  terminalName,
  onClose,
  onFill,
  prepareClipboard,
  prepareFiles,
  prepareFilePaths,
}: TerminalComposerProps) {
  const titleId = useId()
  const text = useTerminalDraftStore(state => state.drafts[terminalId] ?? '')
  const setDraft = useTerminalDraftStore(state => state.setDraft)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const preparing = useRef(false)
  const [error, setError] = useState('')
  const dropHandler = useRef<(paths: string[]) => void>(() => {})

  const insertAttachments = async (prepare: () => Promise<string | null>) => {
    if (preparing.current) return
    const start = input.current?.selectionStart ?? text.length
    const end = input.current?.selectionEnd ?? start
    preparing.current = true
    setBusy(true)
    setError('')
    try {
      const addition = await prepare()
      if (!addition) return
      const latest = useTerminalDraftStore.getState().drafts[terminalId] ?? ''
      const prefix = start > 0 && !/\s$/.test(latest.slice(0, start)) ? ' ' : ''
      const inserted = prefix + addition + ' '
      setDraft(terminalId, latest.slice(0, start) + inserted + latest.slice(end))
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.setSelectionRange(start + inserted.length, start + inserted.length)
      })
    } catch (reason) {
      setError(String(reason))
    } finally {
      preparing.current = false
      setBusy(false)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // Native screenshots/file lists may not expose DOM files or plain text.
    const pastedText = event.clipboardData.getData('text/plain')
    if (
      event.clipboardData.files.length === 0 &&
      pastedText &&
      !parseLocalFilePasteText(pastedText)
    )
      return
    event.preventDefault()
    const native = event.nativeEvent
    // A pasted absolute path may be an ordinary text reference, not an existing file.
    // Keep it if attachment discovery returns nothing.
    void insertAttachments(async () => (await prepareClipboard(native)) || pastedText || null)
  }
  useEffect(() => {
    dropHandler.current = paths => {
      void insertAttachments(() => prepareFilePaths(paths))
    }
  })
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent(event => {
        if (event.payload.type === 'drop') dropHandler.current(event.payload.paths)
      })
      .then(stop => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(reason => setError(String(reason)))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files)
    if (files.length) void insertAttachments(() => prepareFiles(files))
  }

  return (
    <ModalOverlay
      onDismiss={() => {
        if (!busy) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-terminal-composer={terminalId}
        className="modal-content-enter flex max-h-[85vh] w-full max-w-[800px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated text-fg shadow-elevation-3"
        onMouseDown={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()}
        onDragOver={event => event.preventDefault()}
        onDrop={onDrop}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-ui-lg font-semibold">
              {translate('编辑长文本')}
            </h2>
            <p className="truncate text-ui-sm text-fg-muted">
              {translate('填入终端：{name}', { name: terminalName })}
            </p>
          </div>
          <Tooltip label={translate('关闭')}>
            <button
              type="button"
              aria-label={translate('关闭')}
              disabled={busy}
              onClick={onClose}
              className="rounded p-1 hover:bg-bg-hover disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-5 py-4">
          <textarea
            ref={input}
            data-modal-autofocus
            aria-label={translate('长文本内容')}
            value={text}
            disabled={busy}
            onChange={event => {
              setDraft(terminalId, event.target.value)
              setError('')
            }}
            onPaste={onPaste}
            placeholder={translate('输入多段需求，也可粘贴图片或文件…')}
            className="modal-field-input min-h-[200px] flex-1 resize-y font-mono text-ui leading-relaxed"
            style={{ height: 'min(42vh, 420px)' }}
          />
          <p className="text-ui-sm text-fg-muted">
            {translate('支持粘贴图片、文件和拖入附件。填入后请在终端中检查并提交。')}
          </p>
          {busy && (
            <p role="status" className="text-ui-sm text-fg-muted">
              {translate('正在准备附件…')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-ui-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            disabled={busy}
            className="flex items-center gap-1 rounded border border-border-strong px-3 py-1.5 text-ui hover:bg-bg-hover disabled:opacity-50"
            onClick={() => {
              if (!isTauri()) {
                fileInput.current?.click()
                return
              }
              void insertAttachments(async () => {
                const paths = await open({
                  title: translate('选择终端附件'),
                  multiple: true,
                  directory: false,
                })
                return paths ? prepareFilePaths(Array.isArray(paths) ? paths : [paths]) : null
              })
            }}
          >
            <Paperclip size={14} />
            {translate('添加附件')}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            aria-label={translate('选择终端附件')}
            onChange={event => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) void insertAttachments(() => prepareFiles(files))
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !text}
              className="rounded border border-border-strong px-3 py-1.5 text-ui hover:bg-bg-hover disabled:opacity-50"
              onClick={() => {
                void copyToClipboard(text).catch(reason => setError(String(reason)))
              }}
            >
              {translate('复制')}
            </button>
            <button
              type="button"
              disabled={busy || !text.trim()}
              className="rounded bg-action px-3 py-1.5 text-ui text-on-action disabled:opacity-50"
              onClick={() => {
                if (onFill(text)) {
                  setDraft(terminalId, '')
                  onClose()
                } else setError(translate('当前终端无法安全填入多行文本，请使用复制后手动粘贴。'))
              }}
            >
              {translate('填入终端')}
            </button>
          </div>
        </div>
      </section>
    </ModalOverlay>
  )
}
