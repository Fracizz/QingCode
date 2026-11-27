import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { t, translateMessage, accessOptions, resolveAccessMode } from '@qn/codex-client'
import { ArrowUp, CircleAlert,FileText, ImageOff, Paperclip, ShieldAlert, ShieldOff, Slash, Square, Wand2, X } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { agentPlaceholder, sessionKey } from '../lib/agents'
import {
  consumeSlashToken,
  filterSlashItems,
  formatBytes,
  imagePlaceholder,
  insertAtSelection,
  isImageFile,
  MAX_ATTACHMENTS,
  removePlaceholder,
  slashToken,
  uniqueImageName,
  type Attachment,
  type SkillRef,
  type SlashItem,
} from '../lib/attachments'
import { useSetting } from '../features/settings/settingsStore'
import { AccessModePicker } from '../features/access/AccessModePicker'
import { accessKey, getAccessSelection, type AccessAddress } from '../features/access/accessModel'
import {
  applyMention,
  imageSendBlock,
  mentionToken,
  MentionMenu,
  useMentionSearch,
  type ImageSupport,
  type MentionCandidate,
} from '../features/composer'
import { appendProjectMention } from '../features/composer/mentions'
import { receiveProjectMentions } from '../features/composer/projectMention'
import { useDock } from '../store/dock'
import { ImageAttachmentChip } from '../features/composer/ImageAttachmentChip'
import { Suggestions } from '../features/composer/Suggestions'
import { pendingSendKey, useCodex } from '../store/codex'
import { cn } from '../lib/cn'
import type { SendMode } from '../store/codex'
import { ListOption } from './ListOption'
import { LoadingIcon } from './LoadingIcon'
import { Tip } from './primitives'
import { EmptyState, ErrorNote, IconButton } from './ui'

/** 输入框最高占视口 40%，再长就内部滚动，不把消息区挤没。 */
const MAX_HEIGHT_RATIO = 0.4

function fitTextarea(area: HTMLTextAreaElement): void {
  area.style.height = 'auto'
  area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))}px`
}

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
  context,
  placeholder,
  autoFocus,
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
  context?: ReactNode
  placeholder?: string
  autoFocus?: boolean
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
  const accessMode = useCodex((s) => accessAddress ? getAccessSelection(s.access, accessAddress) : 'inherit')
  const inheritedMode = resolveAccessMode(agent, useSetting((settings) => settings.general.globalAccessMode))
  const setAccessMode = useCodex((s) => s.setAccessMode)
  const accessSupported = useCodex((s) => Boolean(targetId && s.sessions[sessionKey(targetId, agent)]?.openedConfig?.accessModes))
  const sendingPending = useCodex((s) => Boolean(targetId && threadId && s.pendingSends[pendingSendKey({ targetId, agent, threadId })]?.[0]?.sending))

  useLayoutEffect(() => {
    if (compact || disabled || !targetId || !root) return
    return receiveProjectMentions(targetId, root, (relative) => {
      const next = appendProjectMention(value, relative)
      pendingCaret.current = next.length
      setCaret(next.length)
      useDock.getState().setView('chat')
      onChange(next)
    })
  }, [compact, disabled, targetId, root, value, onChange])

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    fitTextarea(area)
    // 插入 `@路径` 后把光标放到插入内容之后（受控 textarea 改值后光标会跳到末尾）。
    if (pendingCaret.current !== null) {
      area.focus()
      area.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [value, contentWidthClassName, fontSize])

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area || typeof ResizeObserver === 'undefined') return
    let width = area.offsetWidth
    const observer = new ResizeObserver(() => {
      // 只因宽度变化重新量高，避免写入高度后触发观察循环。
      if (width === area.offsetWidth) return
      width = area.offsetWidth
      fitTextarea(area)
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

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
  const imageSupport = attach?.imageSupport ?? { allowed: true, reason: null }
  const imageBlock = useMemo(() => imageSendBlock(
    attach?.attachments.flatMap((item) => item.kind === 'image' ? [item.dataUrl] : []) ?? [],
    imageSupport.allowed,
    imageSupport.reason ?? undefined,
  ), [attach?.attachments, imageSupport.allowed, imageSupport.reason])
  const hasAttachmentsOrSkills = attachments.length > 0 || (slash?.skills.length ?? 0) > 0
  const blocked = attach?.blockedReason ?? imageBlock
  const shortcut = sendKey === 'ctrlEnter' ? 'Ctrl+Enter' : 'Enter'
  const newlineShortcut = sendKey === 'ctrlEnter' ? 'Enter' : 'Shift+Enter'
  const sendHint = running
    ? t('排队（{shortcut}）· 本轮结束后发送', { shortcut })
    : t('发送（{shortcut}）· 换行（{newline}）', { shortcut, newline: newlineShortcut })
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
    if (item.kind === 'skill') {
      const picked = { name: item.name, path: item.path ?? '' }
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
    if (event.clipboardData.getData('text/plain')) {
      attach.onAddFiles(files)
      return
    }
    event.preventDefault()
    // 图片在光标处留一个 `[名字]` 占位，说明它在正文中的位置；附件改成同名，卡片与占位能对上。
    // 当前不能加图片或附件已满时不插占位，避免留下指向不存在附件的文字。
    const room = MAX_ATTACHMENTS - attachments.length
    if (!imageSupport.allowed || room <= 0) {
      attach.onAddFiles(files)
      return
    }
    const taken = new Set([
      ...attachments.map((item) => item.name),
      ...[...value.matchAll(/\[([^\]\n]+)\]/g)].map((match) => match[1] ?? ''),
    ])
    const placeholders: string[] = []
    const renamed = files.map((file) => {
      if (!isImageFile(file) || placeholders.length >= room) return file
      const name = uniqueImageName(file.name, taken)
      taken.add(name)
      placeholders.push(imagePlaceholder(name))
      return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified })
    })
    const area = event.currentTarget
    if (placeholders.length > 0) {
      const next = insertAtSelection(value, area.selectionStart, area.selectionEnd, placeholders.join(' '))
      pendingCaret.current = next.caret
      setCaret(next.caret)
      onChange(next.value)
    }
    attach.onAddFiles(renamed)
  }

  const removeAttachment = (item: Attachment) => {
    attach?.onRemoveAttachment(item.id)
    if (item.kind === 'image') {
      const next = removePlaceholder(value, item.name)
      if (next !== value) onChange(next)
    }
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

        {(noApprovals || (attach && !imageSupport.allowed) || imageBlock) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-ui-sm leading-4">
            {noApprovals && (
              <span className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5',
                toolsDisabled ? 'border-qn-border-strong bg-qn-panel text-qn-muted' : 'border-qn-warn/30 bg-qn-warn/10 text-qn-warn',
              )}>
                {toolsDisabled ? (
                  <>
                    <ShieldOff size={13} className="shrink-0" aria-hidden />
                    <span>{t('此侧聊已禁用工具')}</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert size={13} className="shrink-0" aria-hidden />
                    <span className="font-medium">{t('无审批')}</span>
                    <span className="text-qn-muted">{t('· 工具直接执行')}</span>
                  </>
                )}
              </span>
            )}
            {attach && !imageSupport.allowed && (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-qn-muted">
                <ImageOff size={12} className="shrink-0" aria-hidden />
                {t('{reason}，图片附件已禁用', { reason: translateMessage(imageSupport.reason ?? '') })}
              </span>
            )}
            {imageBlock && imageSupport.allowed && <span className="text-qn-warn">{translateMessage(imageBlock)}</span>}
          </div>
        )}
        <div
          className={cn(
            'rounded-[20px] border border-qn-outline bg-qn-composer shadow-[var(--qn-composer-shadow)] transition-colors focus-within:border-qn-outline-hover',
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
                  onRemove={() => removeAttachment(item)}
                />
              ))}
              {slash?.skills.map((skill) => (
                <span key={skill.name} className="inline-flex h-7 max-w-[min(14rem,100%)] items-center gap-1 rounded-lg bg-qn-brand/10 pl-2 pr-1 text-ui text-qn-brand">
                  <Wand2 size={13} className="shrink-0" />
                  <span className="truncate" title={skill.name}>{skill.name}</span>
                  <button
                    type="button"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-qn-brand/20"
                    aria-label={t('移除技能 {name}', { name: skill.name })}
                    onClick={() => slash.onSkillsChange(slash.skills.filter((item) => item.name !== skill.name))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {context}
          <textarea
            ref={areaRef}
            className={cn(
              'qn-scroll block w-full resize-none bg-transparent px-4 pt-3.5 text-[length:var(--qn-composer-font-size,15px)] leading-[1.7] text-qn-text outline-none placeholder:text-qn-dim',
              compact ? 'min-h-[48px]' : 'min-h-[56px] max-h-[max(56px,25cqh)]',
            )}
            rows={1}
            value={value}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label={placeholder ?? agentPlaceholder(agent)}
            placeholder={
              placeholder ?? (disabled
                ? t('请先连接目标')
                : slash
                  ? targetId && root
                    ? t('{placeholder}，输入 / 使用命令和技能，@ 引用文件', { placeholder: agentPlaceholder(agent) })
                    : t('{placeholder}，输入 / 使用命令和技能', { placeholder: agentPlaceholder(agent) })
                  : agentPlaceholder(agent))
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
                <Tip label={imageSupport.allowed ? t('添加图片或文件（也可粘贴、拖入）') : t('{reason}，只能添加文件', { reason: translateMessage(imageSupport.reason ?? '') })}>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent"
                    aria-label={t('添加附件')}
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
            {accessAddress && !noApprovals && (
              <AccessModePicker
                key={`${accessKey(accessAddress)}:${threadId === null ? draftRevision : ''}`}
                agent={agent}
                mode={accessMode}
                inheritedMode={inheritedMode}
                supported={accessSupported}
                disabled={Boolean(disabled || sending || running || sendingPending)}
                onChange={(mode) => setAccessMode(accessAddress, draftRevision, mode)}
              />
            )}
            {compact && inheritedMode !== 'default' && (
              <span className="text-ui-sm text-qn-warn">{t('总控 · {mode}', { mode: accessOptions[agent].find((option) => option.mode === inheritedMode)?.label ?? '' })}</span>
            )}
            {trailing}
            <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
              {running && (
                // 与发送钮同为圆形，形成“停止 / 发送”一组；描边保证在输入框底色上可辨识。
                <IconButton
                  label={t('停止运行')}
                  className="rounded-full border border-qn-border-strong text-qn-text hover:border-qn-outline-hover"
                  disabled={sending}
                  onClick={onInterrupt}
                >
                  <Square size={10} fill="currentColor" strokeWidth={0} />
                </IconButton>
              )}
              <Tip label={blocked ? translateMessage(blocked) : sendHint}>
                <span className="inline-flex">
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-8 items-center justify-center gap-1 overflow-hidden rounded-full text-ui-sm font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-accent',
                      running ? 'pl-2.5 pr-3' : 'w-8',
                      canSend ? 'bg-qn-text text-qn-bg hover:bg-qn-text/90' : 'bg-qn-fg/12 text-qn-dim',
                    )}
                    disabled={!canSend}
                    aria-label={running ? t('排队') : t('发送')}
                    onClick={() => submit()}
                  >
                    <ArrowUp size={16} strokeWidth={2.2} />
                    {running && <span>{t('排队')}</span>}
                  </button>
                </span>
              </Tip>
            </div>
          </div>
        </div>
        {footer && <div className="mt-1.5 flex min-h-6 items-center gap-3 px-3 text-ui-sm text-qn-dim">{footer}</div>}
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
      aria-label={`${t('移除')} ${item.name}`}
      onClick={onRemove}
    >
      <X size={12} />
    </button>
  )
  const status =
    item.status === 'uploading' || item.status === 'pending' ? (
      <span className="flex items-center gap-1 text-qn-muted">
        <LoadingIcon size={11} /> {t('上传中')}
      </span>
    ) : item.status === 'error' ? (
      <span className="flex min-w-0 items-center gap-1 text-qn-danger">
        <CircleAlert size={11} className="shrink-0" /> <span className="truncate">{item.error ? translateMessage(item.error) : t('上传失败')}</span>
      </span>
    ) : (
      <span className="text-qn-dim">{formatBytes(item.size)}</span>
    )
  return (
    <div
      className={cn(
        'group/att relative flex h-14 max-w-[15rem] items-center gap-2.5 rounded-lg border bg-qn-fg/[0.03] pl-2.5 pr-3',
        item.status === 'error' ? 'border-qn-danger/40' : 'border-qn-border',
      )}
      title={item.targetPath ?? item.localPath ?? item.name}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-qn-accent/12 text-qn-accent">
        <FileText size={16} />
      </span>
      <span className="min-w-0 text-ui-sm leading-4">
        <span className="block truncate text-ui text-qn-text">{item.name}</span>
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
    <Suggestions label={t('命令与技能')} active={active} confirmHint={t('确认')} listClassName="space-y-0.5">
      {items.length === 0 && (
        <EmptyState className="py-3 leading-5">
          {loading ? t('正在加载技能…') : t('没有匹配的命令或技能')}
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
              item.kind === 'skill' ? 'bg-qn-brand/10 text-qn-brand' : 'bg-qn-fg/[0.06] text-qn-muted',
            )}
          >
            {item.kind === 'skill' ? <Wand2 size={14} /> : <Slash size={14} />}
          </span>
          <span className="min-w-0 flex-1 leading-4">
            <span className="block truncate text-ui text-qn-text">/{item.name}</span>
            {item.description && <span className="block truncate text-ui-sm text-qn-dim">{item.description}</span>}
          </span>
          {item.scope && <span className="shrink-0 text-ui-xs text-qn-dim">{item.scope}</span>}
        </ListOption>
      ))}
    </Suggestions>
  )
}
