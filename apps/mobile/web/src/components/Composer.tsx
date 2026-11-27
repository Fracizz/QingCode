import { chatCommandQuery, exactChatCommand, matchingChatCommands, t, translateMessage, type ChatCommandId, type UserInput } from '@qn/codex-client'
import { ArrowUp, ChevronDown, ChevronUp, FileText, ImagePlus, Slash, Square, Wand2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { callDevice } from '../client'
import { attachmentBytes, IMAGE_BYTES, insertFileMention, isDraftImage, MAX_IMAGES, mentionAt, type DraftImage } from '../composerLogic'
import { useMobilePreferences } from '../mobilePreferences'
import { suggestFiles, type ProjectFile } from '../projectApi'
import { friendlyError, type Annotation } from '../state'
import type { SendMode } from '../store'
import { matchingSkills, type SkillItem } from '../skills'
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
  /** 左侧低频设置（访问模式、模型与推理强度）。 */
  toolbar?: ReactNode
  /** 右侧紧挨添加图片和发送键的常看信息（如上下文占用环）。 */
  trailing?: ReactNode
  canSteer: boolean
  steerHint?: string
  commands?: { run: (id: ChatCommandId) => void; unavailable: (id: ChatCommandId) => string | null }
  /** 输入 / 时与对话命令一起列出的技能；选中后作为 skill 输入随消息发送。 */
  skills?: readonly SkillItem[]
}

type SlashEntry = { kind: 'command'; id: ChatCommandId; name: string; description: string }
  | { kind: 'skill'; skill: SkillItem }

// 相册选择保留在当前应用进程中，避免将大段图片数据写进加密草稿。
const photoDrafts = new Map<string, DraftImage[]>()
const NO_IMAGES: DraftImage[] = []
// 已选技能同样只留在内存草稿里，切换会话再回来仍在。
const skillDrafts = new Map<string, SkillItem[]>()
const NO_SKILLS: SkillItem[] = []
// 技能名可含 : . _（如 plugin:skill），比对话命令的查询更宽。
const SKILL_QUERY = /^\s*\/([\p{L}\p{N}_.:-]*)$/u

function rememberSkills(key: string, skills: SkillItem[]) {
  skillDrafts.delete(key)
  if (skills.length > 0) skillDrafts.set(key, skills)
  if (skillDrafts.size > 12) skillDrafts.delete(skillDrafts.keys().next().value ?? '')
}

function rememberImages(key: string, images: DraftImage[]) {
  photoDrafts.delete(key)
  if (images.length > 0) photoDrafts.set(key, images)
  if (photoDrafts.size > 12) photoDrafts.delete(photoDrafts.keys().next().value ?? '')
}

export function Composer({
  draftKey, text, onChangeText, onSend, onInterrupt, interrupting, running, sending, compacting, disabled, imageUnavailable,
  project, annotations, onUpdateAnnotation, onRemoveAnnotation, quoteDraft, onConfirmQuote,
  onCancelQuote, placeholder = t('和 Codex 一起工作'), toolbar, trailing, canSteer, steerHint, commands, skills,
}: ComposerProps) {
  const sendKey = useMobilePreferences((state) => state.sendKey)
  const [comment, setComment] = useState('')
  const [showAnnotations, setShowAnnotations] = useState(false)
  const [images, setImages] = useState(() => photoDrafts.get(draftKey) ?? NO_IMAGES)
  const [pickedSkills, setPickedSkills] = useState(() => skillDrafts.get(draftKey) ?? NO_SKILLS)
  const [picking, setPicking] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [imeActive, setImeActive] = useState(false)
  const [activeCommand, setActiveCommand] = useState(0)
  const commandList = useRef<HTMLDivElement>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [fileStatus, setFileStatus] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const mounted = useRef(true)
  const mention = project && caret !== null ? mentionAt(text, caret) : null
  const query = mention?.query
  const slashOpen = !disabled && !imeActive && caret === text.length
  const commandQuery = commands && slashOpen ? chatCommandQuery(text) : undefined
  const skillQuery = skills?.length && slashOpen ? SKILL_QUERY.exec(text)?.[1] : undefined
  const slashQuery = commandQuery ?? skillQuery
  const commandMatches: SlashEntry[] = [
    ...(commandQuery === undefined ? [] : matchingChatCommands(commandQuery)
      .map(({ id, name, description }) => ({ kind: 'command' as const, id, name, description }))),
    ...(skillQuery === undefined || !skills ? [] : matchingSkills(skills, skillQuery)
      .filter((skill) => !pickedSkills.some((item) => item.name === skill.name))
      .map((skill) => ({ kind: 'skill' as const, skill }))),
  ]

  useEffect(() => setActiveCommand(0), [slashQuery])
  useEffect(() => {
    commandList.current?.children[activeCommand]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeCommand])

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
    setFileStatus(t('正在查找文件…'))
    const timer = setTimeout(() => {
      void suggestFiles(project, query).then((entries) => {
        if (!current) return
        setFiles(entries)
        setFileStatus(entries.length === 0 ? t('没有匹配的文件') : '')
      }, (error: unknown) => {
        if (current) setFileStatus(friendlyError(error, t('查找文件失败')))
      })
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [project, query])

  function updateSkills(next: SkillItem[]) {
    rememberSkills(draftKey, next)
    if (mounted.current) setPickedSkills(next)
  }

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
        setStatus(t('图片超过可用空间，请选择较小的图片'))
        return
      }
      updateImages(next)
      if (result?.skipped) {
        setStatus(result.skipped === 1 ? t('有 1 张图片无法添加，请选择较小的图片')
          : t('有 {count} 张图片无法添加，请选择较小的图片', { count: result.skipped }))
      }
    } catch (error) {
      if (mounted.current) setStatus(friendlyError(error, t('无法选择图片')))
    } finally {
      if (mounted.current) setPicking(false)
    }
  }

  const canSend = (!disabled && !sending && !compacting && !picking &&
    (!imageUnavailable || images.length === 0) && Boolean(text.trim() || images.length || pickedSkills.length || annotations.length))

  async function submit(mode: SendMode = 'queue') {
    const command = exactChatCommand(text)
    if (commands && !disabled && !composing.current && command) {
      chooseCommand(command.id)
      return
    }
    if (!canSend || composing.current) return
    setCaret(null)
    const attachments: UserInput[] = [
      ...pickedSkills.map((skill): UserInput => ({ type: 'skill', name: skill.name, path: skill.path })),
      ...images.map((image): UserInput => ({ type: 'image', url: image.dataUrl })),
    ]
    if (await onSend(text, attachments, mode)) {
      updateImages([])
      updateSkills([])
    }
  }

  function chooseSlash(entry: SlashEntry) {
    if (entry.kind === 'command') { chooseCommand(entry.id); return }
    if (composing.current) return
    updateSkills([...pickedSkills, entry.skill])
    onChangeText('')
    setCaret(null)
    requestAnimationFrame(() => textarea.current?.focus())
  }

  function chooseCommand(id: ChatCommandId) {
    if (!commands || composing.current) return
    onChangeText('')
    setCaret(null)
    commands.run(id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || composing.current) return
    if (event.key === 'Backspace' && text === '' && pickedSkills.length > 0) {
      updateSkills(pickedSkills.slice(0, -1))
      return
    }
    if (slashQuery !== undefined) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCaret(null)
        return
      }
      if (commandMatches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActiveCommand((index) => (index + delta + commandMatches.length) % commandMatches.length)
        return
      }
      if (commandMatches.length && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
        event.preventDefault()
        if (!event.repeat) chooseSlash(commandMatches[activeCommand] ?? commandMatches[0]!)
        return
      }
    }
    if (event.key === 'Escape' && mention) {
      setCaret(null)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    if (!event.ctrlKey && !event.metaKey && sendKey !== 'send') return
    event.preventDefault()
    if (!event.repeat) void submit()
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
    <div className="qn-footer qn-composer-footer relative">
      {status && <Note message={status} tone="warn" onClose={() => setStatus(null)} />}
      {quoteDraft && (
        <div className="mb-2 rounded-xl border border-qn-border bg-qn-card p-2">
          <div className="qn-mono mb-2 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs text-qn-muted">{quoteDraft}</div>
          <div className="flex gap-2">
            <input
              className="qn-input flex-1"
              value={comment}
              aria-label={t('引用评论')}
              placeholder={t('添加可选评论…')}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) confirmQuote()
                if (event.key === 'Escape') onCancelQuote()
              }}
            />
            <Button variant="primary" className="px-3" onClick={confirmQuote}>{t('引用')}</Button>
            <Button variant="ghost" className="px-3" onClick={onCancelQuote} aria-label={t('取消引用')}><X size={16} /></Button>
          </div>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mb-2">
          <Button variant="ghost" className="px-2 text-xs" aria-expanded={showAnnotations} onClick={() => setShowAnnotations(!showAnnotations)}>
            {annotations.length === 1 ? t('1 条引用') : t('{count} 条引用', { count: annotations.length })} {showAnnotations ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          </Button>
          {showAnnotations && (
            <div className="mt-1 max-h-36 space-y-2 overflow-y-auto">
              {annotations.map((annotation) => (
                <div key={annotation.id} className="rounded-xl border border-qn-border bg-qn-card p-2">
                  <div className="mb-1 flex items-start gap-2">
                    <div className="qn-mono min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-qn-muted">{annotation.quote}</div>
                    <Button variant="ghost" onClick={() => onRemoveAnnotation(annotation.id)} aria-label={t('删除引用')}><X size={16} /></Button>
                  </div>
                  <input className="qn-input" value={annotation.comment} aria-label={t('引用评论')} placeholder={t('评论（可空）')}
                    onChange={(event) => onUpdateAnnotation(annotation.id, event.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {mention && (
        <div className="absolute inset-x-3 bottom-full z-10 mb-1 max-h-48 overflow-y-auto rounded-xl border border-qn-border bg-qn-panel shadow-lg">
          {fileStatus && <div className="px-3 py-2 text-xs text-qn-muted" role="status">{translateMessage(fileStatus)}</div>}
          {files.map((file) => (
            <button key={file.path} type="button" className="qn-row border-b border-qn-border px-3 text-sm last:border-0"
              onPointerDown={(event) => event.preventDefault()} onClick={() => selectFile(file.path)}>
              <FileText size={15} className="shrink-0 text-qn-muted" aria-hidden /><span className="min-w-0 truncate" title={file.path}>{file.path}</span>
            </button>
          ))}
        </div>
      )}
      {commandMatches.length > 0 && (
        <div ref={commandList} role="group" aria-label={t('对话命令')}
          className="absolute inset-x-3 bottom-full z-10 mb-1 max-h-64 overflow-y-auto rounded-xl border border-qn-border bg-qn-panel shadow-lg">
          {commandMatches.map((entry, index) => (
            <button key={entry.kind === 'command' ? `command:${entry.name}` : `skill:${entry.skill.name}`} type="button"
              aria-current={index === activeCommand ? true : undefined}
              className={`qn-row qn-slash-row ${index === activeCommand ? 'bg-qn-hover' : ''}`}
              onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlash(entry)}>
              <span className="qn-slash-icon" data-kind={entry.kind} aria-hidden>
                {entry.kind === 'skill' ? <Wand2 size={14} /> : <Slash size={14} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.kind === 'command' ? `/${entry.name}` : entry.skill.name}</span>
                <span className="block truncate text-xs text-qn-muted">
                  {entry.kind === 'command' ? commands?.unavailable(entry.id) ?? entry.description : entry.skill.description || entry.skill.scope}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && imageUnavailable && <div className="mb-2 text-xs text-qn-warn">{imageUnavailable}</div>}
      <div className="qn-composer">
        {/* 附件放进输入框内：方形缩略图 + 右上角移除角标，与常见聊天应用一致。 */}
        {images.length > 0 && (
          <ul className="qn-composer-images" aria-label={t('图片附件')}>
            {images.map((image, index) => (
              <li className="qn-composer-image" key={`${image.name}:${index}`}>
                <ImageThumbnail src={image.dataUrl} alt={image.name} className="qn-composer-image-img" />
                <button type="button" className="qn-composer-image-remove" disabled={sending || picking}
                  onClick={() => updateImages(images.filter((_, at) => at !== index))} aria-label={t('移除 {name}', { name: image.name })}>
                  <X size={12} strokeWidth={2.5} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {pickedSkills.length > 0 && (
          <ul className="qn-composer-skills" aria-label={t('已选技能')}>
            {pickedSkills.map((skill) => (
              <li key={skill.name} className="qn-skill-chip">
                <Wand2 size={13} aria-hidden />
                <span className="truncate" title={skill.name}>{skill.name}</span>
                <button type="button" disabled={sending} aria-label={t('移除技能 {name}', { name: skill.name })}
                  onClick={() => updateSkills(pickedSkills.filter((item) => item.name !== skill.name))}>
                  <X size={12} strokeWidth={2.5} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textarea}
          className="qn-textarea"
          rows={1}
          value={text}
          disabled={disabled}
          aria-label={t('消息')}
          enterKeyHint={sendKey === 'send' ? 'send' : 'enter'}
          placeholder={running ? t('输入下一条，发送后排队') : placeholder}
          onChange={(event) => { onChangeText(event.target.value); setCaret(event.target.selectionStart) }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onBlur={(event) => { if (!commandList.current?.contains(event.relatedTarget)) setCaret(null) }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; setImeActive(true) }}
          onCompositionEnd={() => { composing.current = false; setImeActive(false) }}
        />
        <div className="qn-composer-toolbar">
          <div className="qn-composer-tools">{toolbar}</div>
          {/* 常用操作靠右、离拇指近：上下文环、添加图片、发送/停止；低频的访问模式与模型在左。 */}
          <div className="qn-composer-actions">
            {trailing}
            <Button variant="ghost" className="qn-icon-button" aria-label={t('添加图片')} title={imageUnavailable}
              onClick={() => void pickImages()} disabled={Boolean(disabled || picking || sending || imageUnavailable || images.length >= MAX_IMAGES)}>
              <ImagePlus size={18} strokeWidth={1.75} aria-hidden />
            </Button>
            {/* 停止与发送共用一个位置（参考 Orca 手机版）：没有可发送内容时是停止键，一输入就换成发送键（排队）。 */}
            {running && !canSend && !sending && (
              <Button variant="danger" className="qn-stop-button" aria-label={interrupting ? t('正在中断') : t('停止运行')}
                aria-busy={interrupting} disabled={sending || interrupting} onClick={onInterrupt}>
                {interrupting ? <LoadingIcon size={14} /> : <Square size={11} fill="currentColor" aria-hidden />}
              </Button>
            )}
            {/* 长按发送键可选「立即发送」（停止本轮后发送），输入后仍能中断当前轮。 */}
            {(!running || canSend || sending) && (
              <SendButton running={running && !compacting} sending={sending} disabled={!canSend} canSteer={canSteer}
                steerHint={steerHint} onSend={(mode) => void submit(mode)} />
            )}
          </div>
        </div>
        {picking && <div className="px-3 pb-2 text-xs text-qn-muted" role="status">{t('选图中…')}</div>}
      </div>
    </div>
  )
}

const LONG_PRESS_MS = 450

/** 发送键：空闲时直接发送；运行中点按排队，长按（或右键）打开发送方式。 */
function SendButton({ running, sending, disabled, canSteer, steerHint = t('补充到当前一轮'), onSend }: {
  running: boolean
  sending: boolean
  disabled: boolean
  canSteer: boolean
  steerHint?: string
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
        aria-label={sending ? t('发送中') : running ? t('排队') : t('发送')}
        title={running ? t('点按排队，长按选择发送方式') : undefined}
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
      {/* 发送键旁不再放下拉箭头：手机上几乎不用，还挤占输入区；其他发送方式靠长按发送键。 */}
      {open && (
        <Dialog title={t('发送方式')} onClose={() => setOpen(false)}>
          <div className="grid gap-2">
            <Button className="justify-between!" onClick={() => select('queue')}>
              <span>{t('排队')}</span><span className="text-xs text-qn-muted">{t('本轮结束后发送')}</span>
            </Button>
            <Button className="justify-between!" disabled={!canSteer} onClick={() => select('steer')}>
              <span>{t('引导')}</span><span className="text-xs text-qn-muted">{canSteer ? steerHint : t('等待当前轮次就绪')}</span>
            </Button>
            <Button className="justify-between!" onClick={() => select('immediate')}>
              <span>{t('立即发送')}</span><span className="text-xs text-qn-muted">{t('停止本轮后发送')}</span>
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}
