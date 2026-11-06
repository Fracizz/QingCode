import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauri } from '../lib/tauri'
import { Paperclip, X } from 'lucide-react'
import Tooltip from './Tooltip'
import { translate } from '../lib/i18n'
import { copyToClipboard } from '../utils/fileReferences'
import { logicalDropPoint } from '../utils/sshExplorerDrop'
import { useTerminalDraftStore } from '../store/terminalDraftStore'
import {
  COMPOSER_MIN_HEIGHT,
  COMPOSER_MIN_WIDTH,
  clampComposerRect,
  defaultComposerRect,
  loadComposerRect,
  saveComposerRect,
  type ComposerRect,
} from '../lib/terminalComposerLayout'

export interface TerminalComposerProps {
  terminalId: string
  terminalName: string
  /** 目标终端当前不可见（切到其他标签/项目）时暂时隐藏面板，保留状态。 */
  hidden?: boolean
  onClose: () => void
  onFill: (text: string) => boolean
  prepareClipboard: (event: globalThis.ClipboardEvent) => Promise<string | null>
  prepareFiles: (files: File[]) => Promise<string | null>
  prepareFilePaths: (paths: string[]) => Promise<string | null>
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

function stopBubble(event: SyntheticEvent) {
  // 面板经 portal 渲染但仍在终端的 React 树内，阻止事件冒泡到终端与窗口拖拽区。
  event.stopPropagation()
}

/**
 * 非模态浮动面板：无遮罩、不模糊，终端保持可滚动、可选择，便于对照编写。
 * 标题栏可拖动、右下角可调整大小，位置尺寸跨打开记忆；不改变 PTY 字符网格。
 */
export default function TerminalComposer({
  terminalId,
  terminalName,
  hidden = false,
  onClose,
  onFill,
  prepareClipboard,
  prepareFiles,
  prepareFilePaths,
}: TerminalComposerProps) {
  const titleId = useId()
  const text = useTerminalDraftStore(state => state.drafts[terminalId] ?? '')
  const setDraft = useTerminalDraftStore(state => state.setDraft)
  const panel = useRef<HTMLElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const preparing = useRef(false)
  const [error, setError] = useState('')
  const dropHandler = useRef<(paths: string[]) => void>(() => {})
  const [rect, setRect] = useState<ComposerRect>(() => loadComposerRect(viewport()))
  const rectRef = useRef(rect)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: ComposerRect; frame: number } | null>(null)

  const commitRect = (next: ComposerRect, persist = true) => {
    rectRef.current = next
    setRect(next)
    if (persist) saveComposerRect(next)
  }

  useLayoutEffect(() => {
    input.current?.focus()
  }, [])

  // 窗口缩放后把面板拉回可见区域。
  useEffect(() => {
    const onResize = () => commitRect(clampComposerRect(rectRef.current, viewport()), false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 右下角原生调整大小：同步尺寸到状态，防止重渲染时回弹，并记住尺寸。
  useEffect(() => {
    const element = panel.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let saveTimer = 0
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth === 0 || element.offsetHeight === 0) return
      const current = rectRef.current
      if (element.offsetWidth === current.width && element.offsetHeight === current.height) return
      const next = { ...current, width: element.offsetWidth, height: element.offsetHeight }
      commitRect(next, false)
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => saveComposerRect(rectRef.current), 200)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.clearTimeout(saveTimer)
    }
  }, [])

  useEffect(() => () => {
    if (drag.current) cancelAnimationFrame(drag.current.frame)
  }, [])

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: rectRef.current,
      frame: 0,
    }
  }
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    const next = clampComposerRect(
      {
        ...state.origin,
        x: state.origin.x + event.clientX - state.startX,
        y: state.origin.y + event.clientY - state.startY,
      },
      viewport()
    )
    rectRef.current = next
    // 拖动期间按帧合并更新位置（状态是唯一来源，避免重渲染把位置回写成旧值），松手后才持久化。
    if (state.frame) return
    state.frame = requestAnimationFrame(() => {
      state.frame = 0
      setRect(rectRef.current)
    })
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    cancelAnimationFrame(state.frame)
    drag.current = null
    commitRect(rectRef.current)
  }

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
    if (event.clipboardData.files.length === 0 && pastedText) return
    event.preventDefault()
    const native = event.nativeEvent
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
        if (event.payload.type !== 'drop') return
        // 非模态：只接收落在本面板上的文件，落在终端上的仍由终端自己处理。
        const point = logicalDropPoint(event.payload.position, window.devicePixelRatio)
        const target = document.elementFromPoint(point.x, point.y)
        if (!panel.current || !target || !panel.current.contains(target)) return
        dropHandler.current(event.payload.paths)
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

  const subtitle = `${translate('填入终端：{name}', { name: terminalName })} · ${translate(
    '支持粘贴图片、文件和拖入附件。填入后请在终端中检查并提交。'
  )}`

  const content = (
    <section
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-terminal-composer={terminalId}
      aria-hidden={hidden || undefined}
      className={`modal-content-enter window-no-drag-region fixed z-[90] ${hidden ? 'hidden' : 'flex'} flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated text-fg shadow-elevation-3`}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        minWidth: `min(${COMPOSER_MIN_WIDTH}px, calc(100vw - 16px))`,
        minHeight: `min(${COMPOSER_MIN_HEIGHT}px, calc(100vh - 16px))`,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)',
        resize: 'both',
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        // 只在焦点位于面板内时响应；焦点在终端时 Escape 照常发给 Claude/OpenCode。
        event.preventDefault()
        event.stopPropagation()
        if (!busy) onClose()
      }}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onContextMenu={stopBubble}
      onDragOver={event => event.preventDefault()}
      onDrop={onDrop}
    >
      <div
        data-terminal-composer-handle=""
        className="flex shrink-0 select-none items-center justify-between gap-3 border-b border-border px-5 py-3"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={event => {
          if ((event.target as HTMLElement).closest('button')) return
          commitRect(defaultComposerRect(viewport()))
        }}
      >
        <div className="min-w-0">
          <h2 id={titleId} className="text-ui-lg font-semibold">
            {translate('编辑长文本')}
          </h2>
          {/* 说明并入标题副行，把纵向空间留给输入框；放不下时截断，悬停看全文。 */}
          <Tooltip label={subtitle} side="bottom" onlyWhenOverflow wrapperClassName="flex min-w-0">
            <p data-terminal-composer-subtitle="" className="truncate text-ui-sm text-fg-muted">
              {subtitle}
            </p>
          </Tooltip>
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
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-5 pb-3 pt-4">
        <textarea
          ref={input}
          aria-label={translate('长文本内容')}
          value={text}
          disabled={busy}
          onChange={event => {
            setDraft(terminalId, event.target.value)
            setError('')
          }}
          onPaste={onPaste}
          placeholder={translate('输入多段需求，也可粘贴图片或文件…')}
          className="modal-field-input min-h-[120px] flex-1 resize-none font-mono text-ui leading-relaxed"
        />
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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border py-3 pl-5 pr-6">
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
  )
  return createPortal(content, document.body)
}
