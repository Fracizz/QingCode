import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, CircleAlert, FileText, ImageOff, Paperclip, Slash, Square, Wand2, X } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { agentPlaceholder, sessionKey } from '../lib/agents'
import {
  consumeSlashToken,
  filterSlashItems,
  formatBytes,
  slashToken,
  type Attachment,
  type SkillRef,
  type SlashItem,
} from '../lib/attachments'
import { useSetting } from '../features/settings/settingsStore'
import { AccessModePicker } from '../features/access/AccessModePicker'
import { accessKey, getAccessMode, type AccessAddress } from '../features/access/accessModel'
import {
  applyMention,
  imageSendBlock,
  mentionToken,
  MentionMenu,
  useMentionSearch,
  type ImageSupport,
  type MentionCandidate,
} from '../features/composer'
import { ImageAttachmentChip } from '../features/composer/ImageAttachmentChip'
import { Suggestions } from '../features/composer/Suggestions'
import { pendingSendKey, useCodex } from '../store/codex'
import { cn } from '../lib/cn'
import type { SendMode } from '../store/codex'
import { ListOption } from './ListOption'
import { LoadingIcon } from './LoadingIcon'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from './primitives'
import { EmptyState, ErrorNote, IconButton } from './ui'

/** 输入框最高占视口 40%，再长就内部滚动，不把消息区挤没。 */
const MAX_HEIGHT_RATIO = 0.4

type AttachmentProps = {
  attachments: Attachment[]
  imageSupport: ImageSupport
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
 * 支持粘贴/拖入图片与文件；行首输入 `/` 弹出命令与技能菜单，输入 `@` 搜索并引用项目文件。卡片下方一行放环境信息。
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
  toolsDisabled = false,
  annotationCount = 0,
  compact = false,
  contentWidthClassName = 'max-w-3xl',
  leading,
  trailing,
  footer,
  attach,
  slash,
}: {
  onSend: (text: string, mode: SendMode) => void | Promise<boolean>
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
  toolsDisabled?: boolean
  capabilities?: { approvals?: boolean; rateLimits?: boolean } | null
  annotationCount?: number
  compact?: boolean
  contentWidthClassName?: string
  leading?: ReactNode
  trailing?: ReactNode
  footer?: ReactNode
  attach?: AttachmentProps
  slash?: SlashProps
}) {
  const sendKey = useSetting((settings) => settings.general.sendKey)
  const fontSize = useSetting((settings) => settings.general.composerFontSize)
  const composing = useRef(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  // composing 是 ref，组合期间要让菜单收起需要一个能触发重渲染的状态。
  const [imeActive, setImeActive] = useState(false)
  const pendingCaret = useRef<number | null>(null)
  // `@` 引用相对当前项目根；没有项目上下文时不启用。
  const targetId = useCodex((s) => s.currentTargetId)
  const root = useCodex((s) => s.currentCwd)
  const threadId = useCodex((s) => s.currentThreadId)
  const draftRevision = useCodex((s) => s.access.draftRevision)
  const accessAddress: AccessAddress | null = !compact && targetId ? { targetId, agent, threadId } : null
  const accessMode = useCodex((s) => accessAddress ? getAccessMode(s.access, accessAddress) : 'default')
  const setAccessMode = useCodex((s) => s.setAccessMode)
  const accessSupported = useCodex((s) => Boolean(targetId && s.sessions[sessionKey(targetId, agent)]?.openedConfig?.accessModes))
  const sendingPending = useCodex((s) => Boolean(targetId && threadId && s.pendingSends[pendingSendKey({ targetId, agent, threadId })]?.[0]?.sending))

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))}px`
    // 插入 `@路径` 后把光标放到插入内容之后（受控 textarea 改值后光标会跳到末尾）。
    if (pendingCaret.current !== null) {
      area.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [value, contentWidthClassName, fontSize])

  const token = slash && !imeActive ? slashToken(value, caret) : null
  const query = token?.query ?? null
  const menuOpen = query !== null && !dismissed && !disabled
  const matches = menuOpen && slash ? filterSlashItems(slash.items, query) : []

  const mention = !disabled && !imeActive && targetId && root ? mentionToken(value, caret) : null
  const mentionOpen = mention !== null && !dismissed && !menuOpen
  const mentionQuery = mentionOpen ? mention.query : null
  const mentionSearch = useMentionSearch(targetId, root, mentionQuery)
  const candidates = mentionSearch.items

  useEffect(() => setActive(0), [query, mentionQuery])

  const attachments = attach?.attachments ?? []
  const images = attachments.flatMap((item) => (item.kind === 'image' ? [item.dataUrl] : []))
  const imageSupport = attach?.imageSupport ?? { allowed: true, reason: null }
  const imageBlock = imageSendBlock(images, imageSupport.allowed, imageSupport.reason ?? undefined)
  const hasAttachmentsOrSkills = attachments.length > 0 || (slash?.skills.length ?? 0) > 0
  const blocked = attach?.blockedReason ?? imageBlock
  const shortcut = sendKey === 'ctrlEnter' ? 'Ctrl+Enter' : 'Enter'
  const newlineShortcut = sendKey === 'ctrlEnter' ? 'Enter' : 'Shift+Enter'
  const sendHint = running ? `排队（${shortcut}）· 本轮结束后发送` : `发送（${shortcut}）· 换行（${newlineShortcut}）`
  const canSend = !disabled && !sending && !blocked && (value.trim() !== '' || hasAttachmentsOrSkills || annotationCount > 0)

  const submit = (mode: SendMode = 'queue') => {
    if (!canSend) return
    void onSend(value, mode)
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

  const chooseMention = (item: MentionCandidate | undefined) => {
    if (!item || !mention) return
    // 只插入相对路径文本，不在客户端读文件内容；Agent 自己按路径读取。
    const next = applyMention(value, mention, item.relative)
    pendingCaret.current = next.caret
    onChange(next.value)
    setCaret(next.caret)
    areaRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current) return
    if (mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActive((index) => (candidates.length ? (index + delta + candidates.length) % candidates.length : 0))
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && candidates.length > 0) {
        event.preventDefault()
        chooseMention(candidates[active])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(true)
        return
      }
    }
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
      <div className={cn('relative mx-auto', !compact && contentWidthClassName)}>
        <ErrorNote message={error} className="qn-scroll mb-2 max-h-[min(5rem,10cqh)] overflow-y-auto" onClose={onClearError} />

        {menuOpen && slash && (
          <SlashMenu items={matches} active={active} loading={slash.loading} onHover={setActive} onChoose={choose} />
        )}
        {mentionOpen && mentionQuery !== null && (
          <MentionMenu
            items={candidates}
            active={active}
            query={mentionQuery}
            searching={mentionSearch.searching}
            error={mentionSearch.error}
            onHover={setActive}
            onChoose={chooseMention}
          />
        )}

        {noApprovals && (
          <div className="mb-1.5 px-3 text-[12px] text-qn-warn">{toolsDisabled ? '此侧聊已禁用工具' : '无审批：工具直接执行'}</div>
        )}
        {attach && !imageSupport.allowed && (
          <div className="mb-1.5 flex items-center gap-1.5 px-3 text-[12px] text-qn-dim">
            <ImageOff size={12} className="shrink-0" />
            {imageSupport.reason}，图片附件已禁用
          </div>
        )}
        <div
          className={cn(
            'rounded-[20px] border border-qn-border-strong bg-qn-panel shadow-[0_8px_24px_rgba(0,0,0,0.25)] transition-colors focus-within:border-[#4a4a4a]',
            disabled && 'opacity-70',
          )}
        >
          {hasAttachmentsOrSkills && (
            <div className="qn-scroll flex max-h-[clamp(4.25rem,12cqh,6rem)] flex-wrap items-center gap-2 overflow-y-auto px-3 pt-3">
              {attach && attachments.map((item) => (
                <AttachmentChip
                  key={item.id}
                  item={item}
                  problem={item.kind === 'image' && !imageSupport.allowed ? imageSupport.reason : null}
                  onRemove={() => attach.onRemoveAttachment(item.id)}
                />
              ))}
              {slash?.skills.map((skill) => (
                <span key={skill.name} className="inline-flex h-7 max-w-[min(14rem,100%)] items-center gap-1 rounded-lg bg-qn-brand/10 pl-2 pr-1 text-[13px] text-qn-brand">
                  <Wand2 size={13} className="shrink-0" />
                  <span className="truncate" title={skill.name}>{skill.name}</span>
                  <button
                    type="button"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-qn-brand/20"
                    aria-label={`移除技能 ${skill.name}`}
                    onClick={() => slash.onSkillsChange(slash.skills.filter((item) => item.name !== skill.name))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={areaRef}
            className={cn(
              'qn-scroll block w-full resize-none bg-transparent px-4 pt-3.5 text-[length:var(--qn-composer-font-size,14px)] leading-[1.7] text-qn-text outline-none placeholder:text-qn-dim',
              compact ? 'min-h-[48px]' : 'min-h-[56px] max-h-[max(56px,25cqh)]',
            )}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={
              disabled
                ? '请先连接目标'
                : slash
                  ? `${agentPlaceholder(agent)}，输入 / 使用命令和技能${targetId && root ? '，@ 引用文件' : ''}`
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
              setImeActive(true)
            }}
            onCompositionEnd={() => {
              composing.current = false
              setImeActive(false)
              syncCaret()
            }}
          />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1 whitespace-nowrap">
            {attach && (
              <>
                <Tip label={imageSupport.allowed ? '添加图片或文件（也可粘贴、拖入）' : `${imageSupport.reason}，只能添加文件`}>
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
            <div className="flex-1" />
            {accessAddress && !noApprovals && (accessSupported || accessMode !== 'default') && (
              <AccessModePicker
                key={`${accessKey(accessAddress)}:${threadId === null ? draftRevision : ''}`}
                agent={agent}
                mode={accessMode}
                disabled={Boolean(disabled || sending || running || sendingPending || !accessSupported)}
                onChange={(mode) => setAccessMode(accessAddress, draftRevision, mode)}
              />
            )}
            {trailing}
            {running && (
              <IconButton label="停止运行" className="size-7.5" disabled={sending} onClick={onInterrupt}>
                <Square size={12} fill="currentColor" />
              </IconButton>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <Tip label={blocked ?? sendHint}>
                <span className="inline-flex">
                  <button
                    type="button"
                    className="inline-flex h-8 items-center justify-center gap-1 rounded-full bg-qn-text px-2 text-[12px] font-medium text-black hover:bg-white disabled:bg-white/15 disabled:text-qn-dim disabled:opacity-100"
                    disabled={!canSend}
                    aria-label={running ? '排队' : '发送'}
                    onClick={() => submit()}
                  >
                    <ArrowUp size={16} strokeWidth={2.2} />
                    {running && <span className="pr-0.5">排队</span>}
                  </button>
                </span>
              </Tip>
              {running && (
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton label="发送方式" size="sm" disabled={!canSend}>
                      <ChevronDown size={14} />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent side="top" align="end">
                    <MenuItem hint="默认 · 本轮结束后发送" onSelect={() => submit('queue')}>排队</MenuItem>
                    <MenuItem
                      disabled={agent !== 'codex'}
                      hint={agent === 'codex' ? '补充到当前一轮' : '当前 Agent 不支持'}
                      onSelect={() => submit('steer')}
                    >引导</MenuItem>
                    <MenuItem hint="中断当前一轮后发送" onSelect={() => submit('immediate')}>立即发送</MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </div>
          </div>
        </div>
        {footer && <div className="mt-1.5 flex min-h-6 items-center gap-3 px-3 text-[12px] text-qn-dim">{footer}</div>}
      </div>
    </div>
  )
}

function AttachmentChip({
  item,
  problem,
  onRemove,
}: {
  item: Attachment
  /** 不能随消息发送的原因（如当前模型不支持图片），有值时标红提示。 */
  problem?: string | null
  onRemove: () => void
}) {
  if (item.kind === 'image') {
    return <ImageAttachmentChip item={item} problem={problem} onRemove={onRemove} />
  }

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
  const status =
    item.status === 'uploading' || item.status === 'pending' ? (
      <span className="flex items-center gap-1 text-qn-muted">
        <LoadingIcon size={11} /> 上传中
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
  return (
    <Suggestions label="命令与技能" active={active} confirmHint="确认" listClassName="space-y-0.5">
      {items.length === 0 && (
        <EmptyState className="py-3 leading-5">
          {loading ? '正在加载技能…' : '没有匹配的命令或技能'}
        </EmptyState>
      )}
      {items.map((item, index) => (
        <ListOption
          key={item.id}
          data-index={index}
          selected={index === active}
          className="gap-2 py-1.5"
          onMouseEnter={() => onHover(index)}
          // 阻止输入框失焦，避免菜单在选择前关闭。
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(item)}
        >
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
              item.kind === 'skill' ? 'bg-qn-brand/10 text-qn-brand' : 'bg-white/[0.06] text-qn-muted',
            )}
          >
            {item.kind === 'skill' ? <Wand2 size={14} /> : <Slash size={14} />}
          </span>
          <span className="min-w-0 flex-1 leading-4">
            <span className="block truncate text-[13px] text-qn-text">/{item.name}</span>
            {item.description && <span className="block truncate text-[12px] text-qn-dim">{item.description}</span>}
          </span>
          {item.scope && <span className="shrink-0 text-[11px] text-qn-dim">{item.scope}</span>}
        </ListOption>
      ))}
    </Suggestions>
  )
}
