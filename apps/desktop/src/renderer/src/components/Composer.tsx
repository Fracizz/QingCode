import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { accessOptions, exactChatCommand, hasSkillToken, insertSkillToken, resolveAccessMode, t, translateMessage } from '@qn/codex-client'
import { ArrowUp, CircleAlert, FileText, ImageOff, Paperclip, Shield, ShieldAlert, ShieldOff, Slash, Square, Wand2, X } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { agentPlaceholder, sessionKey } from '../lib/agents'
import {
  consumeSlashToken,
  filterSlashItems,
  formatBytes,
  imagePlaceholder,
  insertImagePlaceholders,
  slashToken,
  type Attachment,
  type SkillRef,
  type SlashItem,
} from '../lib/attachments'
import { useSetting } from '../features/settings/settingsStore'
import { AccessModePicker } from '../features/access/AccessModePicker'
import { accessKey, getAccessSelection, type AccessAddress } from '../features/access/accessModel'
import { useCwdUntrusted } from '../store/projectTrust'
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
const TEXT_LAYOUT = 'whitespace-pre-wrap wrap-anywhere px-4 pt-3.5 text-[length:var(--qn-composer-font-size,15px)] leading-[1.7]'

function fitTextarea(area: HTMLTextAreaElement): void {
  area.style.height = 'auto'
  area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))}px`
}

function syncImageText(area: HTMLTextAreaElement, layer: HTMLDivElement | null): void {
  if (!layer) return
  // 文本框出现滚动条时，两层仍需在相同的宽度换行。
  layer.style.insetInlineEnd = `${area.offsetWidth - area.clientWidth}px`
  layer.scrollTop = area.scrollTop
}

type AttachmentProps = {
  attachments: Attachment[]
  imageSupport: ImageSupport
  /** 返回通过校验的图片名，按添加顺序插入输入框。 */
  onAddFiles: (files: File[]) => string[]
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
  compacting = false,
  contentWidthClassName = 'max-w-3xl',
  context,
  placeholder,
  autoFocus,
  leading,
  trailing,
  footer,
  attach,
  slash,
  suggestionBoundaryRef,
}: {
  onSend: (text: string, mode: SendMode) => void | Promise<boolean>
  onInterrupt: () => void
  running: boolean
  sending: boolean
  compacting?: boolean
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
  suggestionBoundaryRef: RefObject<HTMLDivElement | null>
}) {
  const sendKey = useSetting((settings) => settings.general.sendKey)
  const fontSize = useSetting((settings) => settings.general.composerFontSize)
  const composing = useRef(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const imageTextRef = useRef<HTMLDivElement>(null)
  const imagePreviewTriggers = useRef(new Map<string, HTMLButtonElement>())
  const fileRef = useRef<HTMLInputElement>(null)
  const suggestionAnchorRef = useRef<HTMLDivElement>(null)
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  // composing 是 ref，组合期间要让菜单收起需要一个能触发重渲染的状态。
  const [imeActive, setImeActive] = useState(false)
  // 图片和文件占位都高亮成蓝色标签；只有图片标签可点击预览。
  const { imageTextPattern, imageTokens } = useMemo(() => {
    const items = attach?.attachments ?? []
    const tokens = items.map((item) => imagePlaceholder(item.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return {
      imageTextPattern: tokens.length ? new RegExp(`(${tokens.join('|')})`) : null,
      imageTokens: new Set(items.flatMap((item) => item.kind === 'image' ? [imagePlaceholder(item.name)] : [])),
    }
  }, [attach?.attachments])
  const imageTextParts = !imeActive && imageTextPattern ? value.split(imageTextPattern) : []
  const highlightImages = imageTextParts.length > 1
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
  const untrusted = useCwdUntrusted(targetId, root)
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
    if (areaRef.current) syncImageText(areaRef.current, imageTextRef.current)
  }, [highlightImages, value, contentWidthClassName, fontSize])

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area || typeof ResizeObserver === 'undefined') return
    let width = area.offsetWidth
    const observer = new ResizeObserver(() => {
      // 只因宽度变化重新量高，避免写入高度后触发观察循环。
      if (width !== area.offsetWidth) {
        width = area.offsetWidth
        fitTextarea(area)
      }
      syncImageText(area, imageTextRef.current)
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

  const token = slash && !imeActive ? slashToken(value, caret) : null
  const query = token?.query ?? null
  const menuOpen = query !== null && !dismissed && !disabled
  const standaloneSlash = token && !value.slice(0, token.start).trim() && !value.slice(token.end).trim()
  const matches = menuOpen && slash ? filterSlashItems(
    // 已写进输入框的技能不再重复列出。
    slash.items.filter((item) => item.kind === 'skill' ? !hasSkillToken(value, item.name) : standaloneSlash),
    query,
  ) : []

  const mention = !disabled && !imeActive && targetId && root ? mentionToken(value, caret) : null
  const mentionOpen = mention !== null && !dismissed && !menuOpen
  const mentionQuery = mentionOpen ? mention.query : null
  const mentionSearch = useMentionSearch(targetId, root, mentionQuery)
  const candidates = mentionSearch.items
  const suggestionsOpen = menuOpen || mentionOpen

  useLayoutEffect(() => {
    const anchor = suggestionAnchorRef.current
    const boundary = suggestionBoundaryRef.current
    if (!suggestionsOpen || !anchor || !boundary) return

    const updateHeight = () => {
      // 用消息区的上沿限制浮层，给上下各留 8px，避免盖住会话标题或被窗体裁掉。
      const availableHeight = anchor.getBoundingClientRect().top - boundary.getBoundingClientRect().top - 16
      anchor.style.setProperty('--qn-suggestions-max-height', `${Math.max(0, availableHeight)}px`)
    }
    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateHeight)
    observer.observe(anchor)
    observer.observe(boundary)
    return () => observer.disconnect()
  }, [suggestionsOpen, suggestionBoundaryRef])

  useEffect(() => setActive(0), [query, mentionQuery])

  const attachments = attach?.attachments ?? []
  const imageSupport = attach?.imageSupport ?? { allowed: true, reason: null }
  const imageBlock = useMemo(() => imageSendBlock(
    attach?.attachments.flatMap((item) => item.kind === 'image' ? [item.dataUrl] : []) ?? [],
    imageSupport.allowed,
    imageSupport.reason ?? undefined,
  ), [attach?.attachments, imageSupport.allowed, imageSupport.reason])
  const hasAttachments = attachments.length > 0
  const blocked = attach?.blockedReason ?? imageBlock
  const shortcut = sendKey === 'ctrlEnter' ? 'Ctrl+Enter' : 'Enter'
  const newlineShortcut = sendKey === 'ctrlEnter' ? 'Enter' : 'Shift+Enter'
  const sendHint = running
    ? t('排队（{shortcut}）· 本轮结束后发送', { shortcut })
    : t('发送（{shortcut}）· 换行（{newline}）', { shortcut, newline: newlineShortcut })
  const canSend = !disabled && !sending && !compacting && !blocked && (value.trim() !== '' || hasAttachments || annotationCount > 0)

  const submit = (mode: SendMode = 'queue') => {
    const command = slash && exactChatCommand(value)
    if (slash && command && !disabled && !composing.current) {
      onChange('')
      slash.onCommand(command.name)
      return
    }
    if (!canSend) return
    void onSend(value, mode)
  }

  const choose = (item: SlashItem | undefined) => {
    if (!item || !slash) return
    if (item.kind === 'skill') {
      // 技能以 /名字 留在输入框里，左右各留一个空格；发送时再拆成 skill 输入。
      const token = slashToken(value, caret)
      if (!token) return
      const next = insertSkillToken(value, token.start, token.end, item.name)
      const picked = { name: item.name, path: item.path ?? '' }
      if (!slash.skills.some((skill) => skill.name === picked.name)) {
        slash.onSkillsChange([...slash.skills, picked])
      }
      pendingCaret.current = next.caret
      onChange(next.text)
      setCaret(next.caret)
    } else {
      // 命令只去掉当前这个 "/片段"，其余正文原样保留。
      const nextValue = consumeSlashToken(value, caret)
      onChange(nextValue)
      setCaret(nextValue.length)
      slash.onCommand(item.id)
    }
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

  // 输入法组合被失焦、截图等打断时可能收不到 compositionend，组合状态会卡住：
  // 蓝色附件标签不再显示、回车也发不出去。遇到明确不在组合中的事件就复位。
  const endComposition = () => {
    if (!composing.current) return
    composing.current = false
    setImeActive(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!event.nativeEvent.isComposing && event.keyCode !== 229) endComposition()
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
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && matches.length > 0) {
        event.preventDefault()
        if (!event.repeat) choose(matches[active] ?? matches[0])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(true)
        return
      }
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

  const addFilesAtCaret = (files: File[], pastedText = '') => {
    const names = attach?.onAddFiles(files) ?? []
    const area = areaRef.current
    if (!area || (!pastedText && names.length === 0)) return
    const next = insertImagePlaceholders(value, names, { start: area.selectionStart, end: area.selectionEnd }, pastedText)
    if (next.value === value) area.setSelectionRange(next.caret, next.caret)
    else {
      pendingCaret.current = next.caret
      onChange(next.value)
    }
    setCaret(next.caret)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attach || event.clipboardData.files.length === 0) return
    event.preventDefault()
    addFilesAtCaret([...event.clipboardData.files], event.clipboardData.getData('text/plain'))
  }

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!attach || disabled || event.dataTransfer.files.length === 0) return
    // 拖进正文时沿用粘贴的选区，外层只收起拖放提示。
    event.preventDefault()
    addFilesAtCaret([...event.dataTransfer.files])
  }

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? 0)
  // pi 原生没有审批机制，必须如实提示，不能伪造审批卡片。
  const noApprovals = agent === 'pi' || capabilities?.approvals === false
  const inheritedLabel = compact ? accessOptions[agent].find((option) => option.mode === inheritedMode)?.label : undefined

  return (
    <div className={cn('shrink-0 pb-3 pt-1', compact ? 'px-4' : 'px-6')}>
      <div ref={suggestionAnchorRef} className={cn('relative mx-auto', !compact && contentWidthClassName)}>
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

        {((noApprovals && !compact) || (attach && !imageSupport.allowed) || imageBlock) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-ui-sm leading-4">
            {noApprovals && !compact && (
              <span className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5',
                toolsDisabled ? 'border-qn-border-strong bg-qn-panel text-qn-muted' : 'border-qn-border bg-qn-warn/10 text-qn-warn',
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
            'rounded-[20px] border border-qn-composer-outline bg-qn-composer shadow-[var(--qn-composer-shadow)] transition-colors focus-within:border-qn-outline',
            disabled && 'opacity-70',
          )}
        >
          {hasAttachments && (
            <div className="qn-scroll flex max-h-[clamp(4.25rem,12cqh,6rem)] flex-wrap items-center gap-2 overflow-y-auto px-3 pt-3">
              {attach && attachments.map((item) => (
                <AttachmentChip
                  key={item.id}
                  item={item}
                  problem={item.kind === 'image' && !imageSupport.allowed ? imageSupport.reason : null}
                  onRemove={() => attach.onRemoveAttachment(item.id)}
                  previewButtonRef={item.kind === 'image' ? (button) => {
                    const token = imagePlaceholder(item.name)
                    if (button) imagePreviewTriggers.current.set(token, button)
                    else imagePreviewTriggers.current.delete(token)
                  } : undefined}
                />
              ))}
            </div>
          )}
          {context}
          <div className="relative">
            {/* 只有图片标签接收点击，文件标签和普通文字仍由 textarea 处理选区和编辑。 */}
            {highlightImages && (
              <div
                ref={imageTextRef}
                className={cn(TEXT_LAYOUT, 'pointer-events-none absolute inset-0 overflow-hidden text-qn-text forced-colors:hidden')}
              >
                {imageTextParts.map((part, index) => index % 2 === 0 ? (
                  <span key={index} aria-hidden="true">{part}</span>
                ) : !imageTokens.has(part) ? (
                  <span key={index} aria-hidden="true" className="text-qn-composer-attachment">{part}</span>
                ) : (
                  <span
                    key={index}
                    role="button"
                    tabIndex={0}
                    aria-label={t('预览 {name}', { name: part })}
                    aria-haspopup="dialog"
                    className="pointer-events-auto relative z-10 cursor-zoom-in text-qn-composer-attachment hover:underline focus-visible:outline-2 focus-visible:outline-qn-outline-hover"
                    onClick={() => imagePreviewTriggers.current.get(part)?.click()}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      imagePreviewTriggers.current.get(part)?.click()
                    }}
                  >{part}</span>
                ))}
                {value.endsWith('\n') && <span aria-hidden="true">{'\u200b'}</span>}
              </div>
            )}
            <textarea
              ref={areaRef}
              className={cn(
                TEXT_LAYOUT,
                'qn-scroll relative block w-full resize-none overflow-x-hidden bg-transparent outline-none placeholder:text-qn-dim',
                'min-h-[56px] max-h-[max(56px,25cqh)]',
                highlightImages
                  ? 'text-transparent caret-qn-text selection:bg-[var(--qn-selection)] selection:text-qn-text forced-colors:text-qn-text'
                  : 'text-qn-text',
              )}
              rows={1}
              wrap="soft"
              // 关闭系统拼写检查：中英混排和代码片段会被误标红色波浪线。
              spellCheck={false}
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
                if (!(event.nativeEvent as InputEvent).isComposing) endComposition()
                onChange(event.target.value)
                setCaret(event.target.selectionStart ?? 0)
                setDismissed(false)
              }}
              onSelect={syncCaret}
              onScroll={(event) => {
                if (imageTextRef.current) imageTextRef.current.scrollTop = event.currentTarget.scrollTop
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onDrop={onDrop}
              onCompositionStart={() => {
                composing.current = true
                setImeActive(true)
              }}
              onCompositionEnd={() => {
                composing.current = false
                setImeActive(false)
                syncCaret()
              }}
              onBlur={endComposition}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1 whitespace-nowrap">
            {attach && (
              <>
                <Tip label={imageSupport.allowed ? t('添加图片或文件（也可粘贴、拖入）') : t('{reason}，只能添加文件', { reason: translateMessage(imageSupport.reason ?? '') })}>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover"
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
                    if (files.length) addFilesAtCaret(files)
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
                lockedReason={untrusted ? t('项目未信任') : undefined}
                // 运行中也可修改：访问模式在每轮 turn/start 时读取，当前这一轮不受影响。
                disabled={Boolean(disabled || sending)}
                deferred={running || sendingPending}
                onChange={(mode) => setAccessMode(accessAddress, draftRevision, mode)}
              />
            )}
            {trailing}
            <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
              {running && (
                // 无描边的圆形幽灵按钮，与实心发送钮并排；悬停时用浅底提示可点击。
                <IconButton
                  label={t('停止运行')}
                  className="rounded-full text-qn-text hover:bg-qn-fg/10"
                  disabled={sending}
                  onClick={onInterrupt}
                >
                  <Square size={11} fill="currentColor" strokeWidth={0} className="rounded-[2px]" />
                </IconButton>
              )}
              <Tip label={blocked ? translateMessage(blocked) : sendHint}>
                <span className="inline-flex">
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-8 items-center justify-center gap-1 overflow-hidden rounded-full text-ui-sm font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-outline-hover',
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
        {(compact || footer) && (
          <div className={cn('mt-1.5 flex min-h-6 items-center gap-3 px-3 text-ui-sm', compact ? 'text-qn-muted' : 'text-qn-dim')}>
            {compact && (
              <span className={cn('flex min-w-0 items-center gap-1.5', !noApprovals && inheritedMode !== 'default' && 'text-qn-warn')}>
                {toolsDisabled ? <ShieldOff size={13} className="shrink-0" aria-hidden />
                  : <Shield size={13} className="shrink-0" aria-hidden />}
                <span className="truncate">
                  {toolsDisabled ? t('此侧聊已禁用工具')
                    : noApprovals ? t('此 Agent 不支持审批') : t('总控 · {mode}', { mode: inheritedLabel ?? t('Agent 默认权限') })}
                </span>
              </span>
            )}
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

function AttachmentChip({
  item,
  problem,
  onRemove,
  previewButtonRef,
}: {
  item: Attachment
  /** 不能随消息发送的原因（如当前模型不支持图片），有值时标红提示。 */
  problem?: string | null
  onRemove: () => void
  previewButtonRef?: Ref<HTMLButtonElement>
}) {
  if (item.kind === 'image') {
    return <ImageAttachmentChip item={item} problem={problem} onRemove={onRemove} previewButtonRef={previewButtonRef} />
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
      className="group/att relative flex h-14 min-w-0 max-w-[min(100%,15rem)] items-center gap-2.5 rounded-lg border border-qn-border bg-qn-fg/[0.03] pl-2.5 pr-3"
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
          className="group gap-2 py-1.5"
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
          <span className="min-w-0 flex-1">
            <span className="block wrap-anywhere text-ui leading-5 text-qn-text">/{item.name}</span>
            {item.description && (
              <span className="block truncate text-ui-sm leading-4 text-qn-muted group-aria-selected:text-qn-text/85">
                {item.reason ?? item.description}
              </span>
            )}
          </span>
          {item.scope && <span className="shrink-0 text-ui-xs text-qn-dim">{item.scope}</span>}
        </ListOption>
      ))}
    </Suggestions>
  )
}
