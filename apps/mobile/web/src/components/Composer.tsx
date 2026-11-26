import type { UserInput } from '@qn/codex-client'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { callDevice } from '../client'
import { attachmentBytes, IMAGE_BYTES, insertFileMention, isDraftImage, MAX_IMAGES, mentionAt, type DraftImage } from '../composerLogic'
import { suggestFiles, type ProjectFile } from '../projectApi'
import { friendlyError, type Annotation } from '../state'
import type { Project } from '../types'
import { Button, Note } from './ui'

export type ComposerProps = {
  draftKey: string
  text: string
  onChangeText: (text: string) => void
  onSend: (text: string, attachments: UserInput[], delegate: boolean) => Promise<boolean>
  onInterrupt: () => void
  running: boolean
  sending: boolean
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
  canRequestSubagents?: boolean
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
  draftKey, text, onChangeText, onSend, onInterrupt, running, sending, disabled, imageUnavailable,
  project, annotations, onUpdateAnnotation, onRemoveAnnotation, quoteDraft, onConfirmQuote,
  onCancelQuote, placeholder = '和 Codex 一起工作', toolbar, canRequestSubagents,
}: ComposerProps) {
  const [comment, setComment] = useState('')
  const [showAnnotations, setShowAnnotations] = useState(false)
  const [images, setImages] = useState(() => photoDrafts.get(draftKey) ?? NO_IMAGES)
  const [picking, setPicking] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [fileStatus, setFileStatus] = useState('')
  const [delegate, setDelegate] = useState(false)
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
    input.style.height = `${Math.min(input.scrollHeight + 2, 126)}px`
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

  const canSend = (!running && !disabled && !sending && !picking &&
    (!imageUnavailable || images.length === 0) && Boolean(text.trim() || images.length || annotations.length))

  async function submit() {
    if (!canSend || composing.current) return
    setCaret(null)
    const attachments: UserInput[] = images.map((image) => ({ type: 'image', url: image.dataUrl }))
    if (await onSend(text, attachments, Boolean(canRequestSubagents && delegate))) {
      updateImages([])
      if (mounted.current) setDelegate(false)
    }
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

  function beginMention() {
    const input = textarea.current
    if (!input) return
    const prefix = text.slice(0, input.selectionStart)
    const marker = prefix && !/\s$/.test(prefix) ? ' @' : '@'
    const nextCaret = prefix.length + marker.length
    onChangeText(prefix + marker + text.slice(input.selectionEnd))
    requestAnimationFrame(() => {
      input.focus()
      input.setSelectionRange(nextCaret, nextCaret)
      setCaret(nextCaret)
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
            <Button variant="ghost" className="px-3" onClick={onCancelQuote} aria-label="取消引用">×</Button>
          </div>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mb-2">
          <Button variant="ghost" className="px-2 text-xs" aria-expanded={showAnnotations} onClick={() => setShowAnnotations(!showAnnotations)}>
            {annotations.length} 条引用 <span aria-hidden>{showAnnotations ? '▴' : '▾'}</span>
          </Button>
          {showAnnotations && (
            <div className="mt-1 max-h-36 space-y-2 overflow-y-auto">
              {annotations.map((annotation) => (
                <div key={annotation.id} className="rounded-xl border border-qn-border bg-qn-card p-2">
                  <div className="mb-1 flex items-start gap-2">
                    <div className="qn-mono min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-qn-muted">{annotation.quote}</div>
                    <Button variant="ghost" onClick={() => onRemoveAnnotation(annotation.id)} aria-label="删除引用">×</Button>
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
              <span aria-hidden>↳</span><span className="min-w-0 truncate" title={file.path}>{file.path}</span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="图片附件">
          {images.map((image, index) => (
            <li className="flex items-center gap-1 rounded-xl border border-qn-border px-1" key={`${image.name}:${index}`}>
              <img className="h-9 w-9 rounded object-cover" src={image.dataUrl} alt={image.name} />
              <Button variant="ghost" className="p-0!" disabled={sending || picking} onClick={() => updateImages(images.filter((_, at) => at !== index))} aria-label={`移除 ${image.name}`}>×</Button>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && imageUnavailable && <div className="mb-2 text-xs text-qn-warn">{imageUnavailable}</div>}
      <div className="rounded-xl border border-qn-border bg-qn-card focus-within:border-qn-accent">
        <textarea
          ref={textarea}
          className="qn-textarea block min-h-11 resize-none rounded-none border-0 bg-transparent px-3 py-2.5 text-base"
          rows={1}
          value={text}
          disabled={disabled}
          aria-label="消息"
          placeholder={placeholder}
          onChange={(event) => { onChangeText(event.target.value); setCaret(event.target.selectionStart) }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onBlur={() => setCaret(null)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
        />
        {/* 一行放下：左侧工具可横向滚动，发送键固定在右侧，不会被模型名等挤到下一行。 */}
        <div className="flex min-w-0 items-center gap-1 px-1 pb-1">
          <div className="qn-composer-tools">
            <Button variant="ghost" className="qn-icon-button" aria-label="添加图片" title={imageUnavailable}
              onClick={() => void pickImages()} disabled={Boolean(disabled || picking || sending || imageUnavailable || images.length >= MAX_IMAGES)}>
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="1.5" /><path d="m3 17 5-4 3 3 4-5 6 6" /></svg>
            </Button>
            {project && <Button variant="ghost" className="qn-icon-button" aria-label="引用项目文件" onClick={beginMention} disabled={disabled}>@</Button>}
            {toolbar}
            {canRequestSubagents && (
              <button type="button" className={`qn-chip ${delegate ? 'qn-chip-active' : ''}`}
                aria-label="本条消息请求子代理" aria-pressed={delegate}
                title="随本条消息请求子代理协作，由当前智能体决定如何委派"
                disabled={disabled || sending || running} onClick={() => setDelegate(!delegate)}>
                子代理
              </button>
            )}
            {picking && <span className="shrink-0 text-xs text-qn-muted" role="status">选图中…</span>}
          </div>
          {running ? (
            <Button variant="danger" className="qn-send-button" aria-label="中断" onClick={onInterrupt}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
            </Button>
          ) : (
            <Button variant="primary" className="qn-send-button" aria-label={sending ? '发送中' : '发送'} disabled={!canSend} onClick={() => void submit()}>
              {sending ? <span aria-hidden>…</span> : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
