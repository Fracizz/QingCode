import { ArrowUp, ChevronDown, ChevronUp, FileText, ImagePlus, Square, X } from 'lucide-react'
import type { UserInput } from '@qn/codex-client'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { callDevice } from '../client'
import { attachmentBytes, IMAGE_BYTES, insertFileMention, isDraftImage, MAX_IMAGES, mentionAt, type DraftImage } from '../composerLogic'
import { suggestFiles, type ProjectFile } from '../projectApi'
import { friendlyError, type Annotation } from '../state'
import type { SendMode } from '../store'
import type { Project } from '../types'
import { ImageThumbnail } from './ImageThumbnail'
import { Button, Dialog, LoadingIcon, Note } from './ui'

export type ComposerProps = {
  draftKey: string
  text: string
  onChangeText: (text: string) => void
  onSend: (text: string, attachments: UserInput[], mode: SendMode) => Promise<boolean>
  onInterrupt: () => void
  interrupting?: boolean
  running: boolean
  sending: boolean
  compacting?: boolean
  disabled?: boolean
  imageUnavailable?: string
  project?: Project
  annotations: Annotation[]
  onUpdateAnnotation: (id: string, comment: string) => void
  onRemoveAnnotation: (id: string) => void
  quoteDraft: string | null
  onConfirmQuote: (quote: string, comment: string) => void
  onCancelQuote: () => void
  placeholder?: string
  toolbar?: ReactNode
  canSteer: boolean
}

// 相册选择保留在当前应用进程中，避免将大段图片数据写进加密草稿。
const photoDrafts = new Map<string, DraftImage[]>()
const NO_IMAGES: DraftImage[] = []

function rememberImages(key: string, images: DraftImage[]) {
  photoDrafts.delete(key)
  if (images.length > 0) photoDrafts.set(key, images)
  if (photoDrafts.size > 12) photoDrafts.delete(photoDrafts.keys().next().value ?? '')
}

export function Composer({
  draftKey, text, onChangeText, onSend, onInterrupt, interrupting, running, sending, compacting, disabled, imageUnavailable,
  project, annotations, onUpdateAnnotation, onRemoveAnnotation, quoteDraft, onConfirmQuote,
  onCancelQuote, placeholder = '和 Codex 一起工作', toolbar, canSteer,
}: ComposerProps) {
  const [comment, setComment] = useState('')
  const [showAnnotations, setShowAnnotations] = useState(false)
  const [images, setImages] = useState(() => photoDrafts.get(draftKey) ?? NO_IMAGES)
  const [picking, setPicking] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [fileStatus, setFileStatus] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const mounted = useRef(true)
  const mention = project && caret !== null ? mentionAt(text, caret) : null
  const query = mention?.query

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => setComment(''), [quoteDraft])
  useLayoutEffect(() => {
    const input = textarea.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 126)}px`
  }, [text])
  useEffect(() => {
    if (!project || query === undefined) return
    let current = true
    setFiles([])
    setFileStatus('正在查找文件…')
    const timer = setTimeout(() => {
      void suggestFiles(project, query).then((entries) => {
        if (!current) return
        setFiles(entries)
        setFileStatus(entries.length === 0 ? '没有匹配的文件' : '')
      }, (error: unknown) => {
        if (current) setFileStatus(friendlyError(error, '查找文件失败'))
      })
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [project, query])

  function updateImages(next: DraftImage[]) {
    rememberImages(draftKey, next)
    if (mounted.current) setImages(next)
  }

  async function pickImages() {
    if (disabled || imageUnavailable || picking || images.length >= MAX_IMAGES) return
    setPicking(true)
    setStatus(null)
    try {
      const result = await callDevice<{ images: unknown[]; skipped: number }>('images.pick', {
        maxCount: MAX_IMAGES - images.length,
        maxBytes: IMAGE_BYTES - attachmentBytes(images),
      }, 300_000)
      if (!mounted.current) return
      const incoming = Array.isArray(result?.images) ? result.images.filter(isDraftImage) : []
      const next = [...images, ...incoming].slice(0, MAX_IMAGES)
      if (attachmentBytes(next) > IMAGE_BYTES) {
        setStatus('图片超过可用空间，请选择较小的图片')
        return
      }
      updateImages(next)
      if (result?.skipped) setStatus(`有 ${result.skipped} 张图片无法添加，请选择较小的图片`)
    } catch (error) {
      if (mounted.current) setStatus(friendlyError(error, '无法选择图片'))
    } finally {
      if (mounted.current) setPicking(false)
    }
  }

  const canSend = (!disabled && !sending && !compacting && !picking &&
    (!imageUnavailable || images.length === 0) && Boolean(text.trim() || images.length || annotations.length))

  async function submit(mode: SendMode = 'queue') {
    if (!canSend || composing.current) return
    setCaret(null)
    const attachments: UserInput[] = images.map((image) => ({ type: 'image', url: image.dataUrl }))
    if (await onSend(text, attachments, mode)) updateImages([])
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && mention) {
      setCaret(null)
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  function confirmQuote() {
    if (quoteDraft) onConfirmQuote(quoteDraft, comment)
  }

  function selectFile(path: string) {
    if (!mention) return
    const next = insertFileMention(text, mention, path)
    onChangeText(next.text)
    setCaret(null)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  return (
    <div className="qn-footer relative">
      {status && <Note message={status} tone="warn" onClose={() => setStatus(null)} />}
      {quoteDraft && (
        <div className="mb-2 rounded-xl border border-qn-border bg-qn-card p-2">
          <div className="qn-mono mb-2 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs text-qn-muted">{quoteDraft}</div>
          <div className="flex gap-2">
            <input
              className="qn-input flex-1"
              value={comment}
              aria-label="引用评论"
              placeholder="添加可选评论…"
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) confirmQuote()
                if (event.key === 'Escape') onCancelQuote()
              }}
            />
            <Button variant="primary" className="px-3" onClick={confirmQuote}>引用</Button>
            <Button variant="ghost" className="px-3" onClick={onCancelQuote} aria-label="取消引用"><X size={16} /></Button>
          </div>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mb-2">
          <Button variant="ghost" className="px-2 text-xs" aria-expanded={showAnnotations} onClick={() => setShowAnnotations(!showAnnotations)}>
            {annotations.length} 条引用 {showAnnotations ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          </Button>
          {showAnnotations && (
            <div className="mt-1 max-h-36 space-y-2 overflow-y-auto">
              {annotations.map((annotation) => (
                <div key={annotation.id} className="rounded-xl border border-qn-border bg-qn-card p-2">
                  <div className="mb-1 flex items-start gap-2">
                    <div className="qn-mono min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-qn-muted">{annotation.quote}</div>
                    <Button variant="ghost" onClick={() => onRemoveAnnotation(annotation.id)} aria-label="删除引用"><X size={16} /></Button>
                  </div>
                  <input className="qn-input" value={annotation.comment} aria-label="引用评论" placeholder="评论（可空）"
                    onChange={(event) => onUpdateAnnotation(annotation.id, event.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {mention && (
        <div className="absolute inset-x-3 bottom-full z-10 mb-1 max-h-48 overflow-y-auto rounded-xl border border-qn-border bg-qn-panel shadow-lg">
          {fileStatus && <div className="px-3 py-2 text-xs text-qn-muted" role="status">{fileStatus}</div>}
          {files.map((file) => (
            <button key={file.path} type="button" className="qn-row border-b border-qn-border px-3 text-sm last:border-0"
              onPointerDown={(event) => event.preventDefault()} onClick={() => selectFile(file.path)}>
              <FileText size={15} className="shrink-0 text-qn-muted" aria-hidden /><span className="min-w-0 truncate" title={file.path}>{file.path}</span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="图片附件">
          {images.map((image, index) => (
            <li className="flex items-center gap-1 rounded-xl border border-qn-border px-1" key={`${image.name}:${index}`}>
              <ImageThumbnail src={image.dataUrl} alt={image.name} className="h-11 w-11 rounded-lg object-cover" />
              <Button variant="ghost" className="p-0!" disabled={sending || picking} onClick={() => updateImages(images.filter((_, at) => at !== index))} aria-label={`移除 ${image.name}`}><X size={15} /></Button>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && imageUnavailable && <div className="mb-2 text-xs text-qn-warn">{imageUnavailable}</div>}
      <div className="qn-composer">
        <textarea
          ref={textarea}
          className="qn-textarea"
          rows={1}
          value={text}
          disabled={disabled}
          aria-label="消息"
          placeholder={running ? '输入下一条，发送后排队' : placeholder}
          onChange={(event) => { onChangeText(event.target.value); setCaret(event.target.selectionStart) }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onBlur={() => setCaret(null)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
        />
        <div className="qn-composer-toolbar">
          <div className="qn-composer-tools">
            <Button variant="ghost" className="qn-icon-button" aria-label="添加图片" title={imageUnavailable}
              onClick={() => void pickImages()} disabled={Boolean(disabled || picking || sending || imageUnavailable || images.length >= MAX_IMAGES)}>
              <ImagePlus size={19} strokeWidth={1.75} aria-hidden />
            </Button>
            {toolbar}
          </div>
          <div className="qn-composer-actions">
            {running && (
              <Button variant="danger" className="qn-stop-button" aria-label={interrupting ? '正在中断' : '停止运行'}
                aria-busy={interrupting} disabled={sending || interrupting} onClick={onInterrupt}>
                {interrupting ? <LoadingIcon size={14} /> : <Square size={11} fill="currentColor" aria-hidden />}
              </Button>
            )}
            {/* 运行中且没有内容时只留停止键；有内容后再出现发送键（排队），长按选其他发送方式。 */}
            {(!running || canSend || sending) && (
              <SendButton running={running && !compacting} sending={sending} disabled={!canSend} canSteer={canSteer}
                onSend={(mode) => void submit(mode)} />
            )}
          </div>
        </div>
        {picking && <div className="px-3 pb-2 text-xs text-qn-muted" role="status">选图中…</div>}
      </div>
    </div>
  )
}

const LONG_PRESS_MS = 450

/** 发送键：空闲时直接发送；运行中点按排队，长按（或右键）打开发送方式。 */
function SendButton({ running, sending, disabled, canSteer, onSend }: {
  running: boolean
  sending: boolean
  disabled: boolean
  canSteer: boolean
  onSend: (mode: SendMode) => void
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function select(mode: SendMode) {
    setOpen(false)
    onSend(mode)
  }

  function cancelPress() {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }

  return (
    <>
      <Button variant="primary" className="qn-send-button"
        aria-label={sending ? '发送中' : running ? '排队' : '发送'}
        title={running ? '点按排队，长按选择发送方式' : undefined}
        aria-haspopup={running ? 'dialog' : undefined}
        disabled={disabled}
        onPointerDown={() => {
          longPressed.current = false
          if (!running || disabled) return
          cancelPress()
          timer.current = window.setTimeout(() => {
            longPressed.current = true
            navigator.vibrate?.(12)
            setOpen(true)
          }, LONG_PRESS_MS)
        }}
        onPointerUp={cancelPress} onPointerLeave={cancelPress} onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          if (!running) return
          event.preventDefault()
          if (!longPressed.current && !disabled) setOpen(true)
          longPressed.current = true
        }}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false
            return
          }
          onSend('queue')
        }}>
        {sending ? <LoadingIcon size={16} /> : <ArrowUp size={18} strokeWidth={2.25} aria-hidden />}
      </Button>
      {running && !disabled && (
        <Button variant="ghost" className="qn-icon-button qn-send-options" aria-label="发送方式" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <ChevronDown size={15} aria-hidden />
        </Button>
      )}
      {open && (
        <Dialog title="发送方式" onClose={() => setOpen(false)}>
          <div className="grid gap-2">
            <Button className="justify-between!" onClick={() => select('queue')}>
              <span>排队</span><span className="text-xs text-qn-muted">本轮结束后发送</span>
            </Button>
            <Button className="justify-between!" disabled={!canSteer} onClick={() => select('steer')}>
              <span>引导</span><span className="text-xs text-qn-muted">{canSteer ? '补充到当前一轮' : '当前 Agent 暂不可用'}</span>
            </Button>
            <Button className="justify-between!" onClick={() => select('immediate')}>
              <span>立即发送</span><span className="text-xs text-qn-muted">停止本轮后发送</span>
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}
