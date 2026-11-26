import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, CircleAlert, FileText, LoaderCircle, Paperclip, Slash, Square, Wand2, X } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { agentPlaceholder } from '../lib/agents'
import {
  consumeSlashToken,
  filterSlashItems,
  formatBytes,
  slashToken,
  type Attachment,
  type SkillRef,
  type SlashItem,
} from '../lib/attachments'
import { useSetting } from '../features/settings'
import { cn } from '../lib/cn'
import { Tip } from './primitives'
import { ErrorNote } from './ui'

/** 输入框最高占视口 40%，再长就内部滚动，不把消息区挤没。 */
const MAX_HEIGHT_RATIO = 0.4

type AttachmentProps = {
  attachments: Attachment[]
  onAddFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  /** 还不能发送的原因（如附件上传中）。 */
  blockedReason?: string | null
}

type SlashProps = {
  /** 斜杠菜单候选（内置命令 + 技能）；不传则不启用斜杠菜单。 */
  items: SlashItem[]
  loading?: boolean
  /** 一条消息可以同时挂多个技能，按选择顺序发送。 */
  skills: SkillRef[]
  onSkillsChange: (skills: SkillRef[]) => void
  onCommand: (id: string) => void
}

/**
 * 输入框（参考 Codex）：圆角卡片里是附件托盘 + 自动增高的文本框，底部一行左侧放附件按钮/上下文工具、右侧放模型选择/上下文占用/发送。
 * 支持粘贴/拖入图片与文件；行首输入 `/` 弹出命令与技能菜单。运行中发送键变成停止键；卡片下方一行放环境信息。
 */
export function Composer({
  onSend,
  onInterrupt,
  running,
  sending,
  disabled,
  error,
  onClearError,
  value,
  onChange,
  agent,
  capabilities,
  annotationCount = 0,
  compact = false,
  leading,
  trailing,
  footer,
  attach,
  slash,
}: {
  onSend: (text: string) => void
  onInterrupt: () => void
  running: boolean
  sending: boolean
  disabled?: boolean
  error: string | null
  onClearError: () => void
  value: string
  onChange: (value: string) => void
  agent: AgentKind
  /** codex.open 的能力字段；pi 为 { approvals: false }，未透传时按 agent 兜底。 */
  capabilities?: { approvals?: boolean; rateLimits?: boolean } | null
  annotationCount?: number
  compact?: boolean
  leading?: ReactNode
  trailing?: ReactNode
  footer?: ReactNode
  attach?: AttachmentProps
  slash?: SlashProps
}) {
  const sendKey = useSetting((settings) => settings.general.sendKey)
  const composing = useRef(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))}px`
  }, [value])

  const token = slash ? slashToken(value, caret) : null
  const query = token?.query ?? null
  const menuOpen = query !== null && !dismissed && !disabled
  const matches = menuOpen && slash ? filterSlashItems(slash.items, query) : []

  useEffect(() => setActive(0), [query])

  const attachments = attach?.attachments ?? []
  const hasExtras = attachments.length > 0 || (slash?.skills.length ?? 0) > 0 || annotationCount > 0
  const blocked = attach?.blockedReason ?? null
  const canSend = !disabled && !sending && !blocked && (value.trim() !== '' || hasExtras)

  const submit = () => {
    if (!canSend) return
    onSend(value)
    onChange('')
  }

  const choose = (item: SlashItem | undefined) => {
    if (!item || !slash) return
    // 只去掉当前这个 "/片段"，其余正文原样保留；光标落到末尾，剩下的 /技能 可以接着选。
    const nextValue = consumeSlashToken(value, caret)
    onChange(nextValue)
    setCaret(nextValue.length)
    if (item.kind === 'skill' && item.path) {
      const picked = { name: item.name, path: item.path }
      if (!slash.skills.some((skill) => skill.name === picked.name)) {
        slash.onSkillsChange([...slash.skills, picked])
      }
    } else slash.onCommand(item.id)
    areaRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current) return
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActive((index) => (matches.length ? (index + delta + matches.length) % matches.length : 0))
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && matches.length > 0) {
        event.preventDefault()
        choose(matches[active])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(true)
        return
      }
    }
    // 空输入时退格先移除最后选的技能，和 Codex 的 chip 行为一致。
    if (event.key === 'Backspace' && value === '' && slash && slash.skills.length > 0) {
      slash.onSkillsChange(slash.skills.slice(0, -1))
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      // 设置 → 通用 → 发送快捷键：Enter 发送，或 Ctrl+Enter 发送（此时 Enter 换行）。
      const ctrl = event.ctrlKey || event.metaKey
      if (sendKey === 'ctrlEnter' ? ctrl : !ctrl) {
        event.preventDefault()
        submit()
      }
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attach) return
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    // 只有文件（截图、资源管理器里复制的文件）时拦下默认粘贴，避免把文件名当文字贴进来。
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    attach.onAddFiles(files)
  }

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? 0)
  // pi 原生没有审批机制，必须如实提示，不能伪造审批卡片。
  const noApprovals = agent === 'pi' || capabilities?.approvals === false

  return (
    <div className={cn('shrink-0', compact ? 'px-3 pb-3 pt-1' : 'px-6 pb-3 pt-1')}>
      <div className={cn('relative mx-auto', !compact && 'max-w-3xl')}>
        {error && (
          <div className="mb-2">
            <ErrorNote message={error} onClose={onClearError} />
          </div>
        )}

        {menuOpen && slash && (
          <SlashMenu items={matches} active={active} loading={slash.loading} onHover={setActive} onChoose={choose} />
        )}

        {noApprovals && (
          <div className="mb-1.5 px-3 text-[12px] text-qn-dim">pi 不经审批直接执行工具</div>
        )}
        <div
          className={cn(
            'rounded-[20px] border border-qn-border-strong bg-qn-panel shadow-[0_8px_24px_rgba(0,0,0,0.25)] transition-colors focus-within:border-[#4a4a4a]',
            disabled && 'opacity-70',
          )}
        >
          {attachments.length > 0 && attach && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((item) => (
                <AttachmentChip key={item.id} item={item} onRemove={() => attach.onRemoveAttachment(item.id)} />
              ))}
            </div>
          )}
          <textarea
            ref={areaRef}
            className={cn(
              'qn-scroll block w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-6 text-qn-text outline-none placeholder:text-qn-dim',
              compact ? 'min-h-[48px]' : 'min-h-[56px]',
            )}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={
              disabled
                ? '请先连接目标'
                : slash
                  ? `${agentPlaceholder(agent)}，输入 / 使用命令和技能`
                  : agentPlaceholder(agent)
            }
            onChange={(event) => {
              onChange(event.target.value)
              setCaret(event.target.selectionStart ?? 0)
              setDismissed(false)
            }}
            onSelect={syncCaret}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
              syncCaret()
            }}
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            {attach && (
              <>
                <Tip label="添加图片或文件（也可粘贴、拖入）">
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent"
                    aria-label="添加附件"
                    disabled={disabled}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Paperclip size={16} />
                  </button>
                </Tip>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])]
                    event.target.value = ''
                    if (files.length) attach.onAddFiles(files)
                  }}
                />
              </>
            )}
            {leading}
            {slash?.skills.map((skill) => (
              <span key={skill.name} className="inline-flex h-7 max-w-[14rem] items-center gap-1 rounded-lg bg-qn-brand/10 pl-2 pr-1 text-[13px] text-qn-brand">
                <Wand2 size={13} className="shrink-0" />
                <span className="truncate">{skill.name}</span>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-md hover:bg-qn-brand/20"
                  aria-label={`移除技能 ${skill.name}`}
                  onClick={() => slash.onSkillsChange(slash.skills.filter((item) => item.name !== skill.name))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {annotationCount > 0 && (
              <span className="rounded-md bg-qn-accent/10 px-2 py-0.5 text-[12px] text-qn-accent">
                {annotationCount} 条注释随消息发送
              </span>
            )}
            <div className="flex-1" />
            {trailing}
            {running ? (
              <Tip label="停止运行">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-qn-text text-black hover:bg-white"
                  aria-label="停止运行"
                  onClick={onInterrupt}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              </Tip>
            ) : (
              <Tip label={blocked ?? (sendKey === 'ctrlEnter' ? '发送（Ctrl+Enter）· 换行（Enter）' : '发送（Enter）· 换行（Shift+Enter）')}>
                {/* 禁用的 button 不触发悬停事件，外包一层让提示仍能显示原因。 */}
                <span className="inline-flex">
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-qn-text text-black hover:bg-white disabled:bg-white/15 disabled:text-qn-dim disabled:opacity-100"
                    disabled={!canSend}
                    aria-label="发送"
                    onClick={submit}
                  >
                    <ArrowUp size={16} strokeWidth={2.2} />
                  </button>
                </span>
              </Tip>
            )}
          </div>
        </div>
        {footer && <div className="mt-1.5 flex min-h-6 items-center gap-3 px-3 text-[12px] text-qn-dim">{footer}</div>}
      </div>
    </div>
  )
}

function AttachmentChip({ item, onRemove }: { item: Attachment; onRemove: () => void }) {
  const remove = (
    <button
      type="button"
      className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border border-qn-border-strong bg-qn-elevated text-qn-muted shadow hover:text-qn-text group-hover/att:flex"
      aria-label={`移除 ${item.name}`}
      onClick={onRemove}
    >
      <X size={12} />
    </button>
  )
  if (item.kind === 'image') {
    return (
      <Tip label={`${item.name} · ${formatBytes(item.size)}`}>
        <div className="group/att relative h-14 w-14">
          <img src={item.dataUrl} alt={item.name} className="h-14 w-14 rounded-lg border border-qn-border object-cover" />
          {remove}
        </div>
      </Tip>
    )
  }
  const status =
    item.status === 'uploading' || item.status === 'pending' ? (
      <span className="flex items-center gap-1 text-qn-muted">
        <LoaderCircle size={11} className="animate-spin" /> 上传中
      </span>
    ) : item.status === 'error' ? (
      <span className="flex min-w-0 items-center gap-1 text-qn-danger">
        <CircleAlert size={11} className="shrink-0" /> <span className="truncate">{item.error ?? '上传失败'}</span>
      </span>
    ) : (
      <span className="text-qn-dim">{formatBytes(item.size)}</span>
    )
  return (
    <div
      className={cn(
        'group/att relative flex h-14 max-w-[15rem] items-center gap-2.5 rounded-lg border bg-white/[0.03] pl-2.5 pr-3',
        item.status === 'error' ? 'border-qn-danger/40' : 'border-qn-border',
      )}
      title={item.targetPath ?? item.localPath ?? item.name}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-qn-accent/12 text-qn-accent">
        <FileText size={16} />
      </span>
      <span className="min-w-0 text-[12px] leading-4">
        <span className="block truncate text-[13px] text-qn-text">{item.name}</span>
        {status}
      </span>
      {remove}
    </div>
  )
}

function SlashMenu({
  items,
  active,
  loading,
  onHover,
  onChoose,
}: {
  items: SlashItem[]
  active: number
  loading?: boolean
  onHover: (index: number) => void
  onChoose: (item: SlashItem) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      className="qn-no-drag qn-pop qn-surface-float absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden"
      role="listbox"
      aria-label="命令与技能"
    >
      <div ref={listRef} className="qn-scroll max-h-[min(320px,45vh)] overflow-y-auto p-1.5">
        {items.length === 0 && (
          <div className="px-3 py-3 text-center text-[13px] text-qn-muted">
            {loading ? '正在加载技能…' : '没有匹配的命令或技能'}
          </div>
        )}
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none',
              index === active ? 'bg-qn-active' : 'hover:bg-qn-hover',
            )}
            onMouseEnter={() => onHover(index)}
            // mousedown 时就阻止默认行为，避免输入框失焦后菜单先关掉。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(item)}
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                item.kind === 'skill' ? 'bg-qn-brand/10 text-qn-brand' : 'bg-white/[0.06] text-qn-muted',
              )}
            >
              {item.kind === 'skill' ? <Wand2 size={14} /> : <Slash size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-qn-text">/{item.name}</span>
              {item.description && <span className="block truncate text-[12px] text-qn-dim">{item.description}</span>}
            </span>
            {item.scope && <span className="shrink-0 text-[11px] text-qn-dim">{item.scope}</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-qn-border px-3 py-1.5 text-[11px] text-qn-dim">
        <span>↑↓ 选择</span>
        <span>Enter / Tab 确认</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
