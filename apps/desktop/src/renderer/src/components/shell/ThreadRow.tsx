import { t, isActiveThread, sessionStatus, sessionStatusLabels, type SessionStatus } from '@qn/codex-client'
import { memo, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ComponentProps, type ReactNode } from 'react'
import { ContextMenu } from 'radix-ui'
import {
  Archive,
  Check,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { agentLabel, DEFAULT_AGENT, sessionKey } from '../../lib/agents'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { formatTime, threadKey, threadPreviewText, type ThreadSummary } from '../../lib/threads'
import { formatRelative } from '../../lib/time'
import { useCodex } from '../../store/codex'
import { useThreadPrefs } from '../../store/threadPrefs'
import { AgentIcon } from '../AgentIcon'
import { LoadingIcon } from '../LoadingIcon'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, floatSurface, menuItemClass, MenuItemContent, Tip } from '../primitives'
import { IconButton, Modal } from '../ui'

type ThreadRowStatus = Exclude<SessionStatus, 'idle' | 'completed'> | 'opening'

const statusIcons: Record<ThreadRowStatus, ReactNode> = {
  running: <LoadingIcon />,
  pending: <ShieldAlert size={13} className="text-qn-warn" aria-hidden />,
  input: <MessageSquare size={13} className="text-qn-warn" aria-hidden />,
  failed: <CircleAlert size={13} className="text-qn-danger" aria-hidden />,
  interrupted: <CirclePause size={13} className="text-qn-muted" aria-hidden />,
  unread: <Check size={14} strokeWidth={2.5} className="text-qn-ok" aria-hidden />,
  opening: <LoadingIcon />,
}

function ThreadStatusIcon({ status, label }: { status: ThreadRowStatus | 'idle'; label: string }) {
  // 空闲时保留图标位置，让会话标题与项目名对齐。
  if (status === 'idle') return <span className="size-(--qn-tree-icon-size) shrink-0" aria-hidden />

  return (
    <Tip label={label}>
      <span
        className="flex size-(--qn-tree-icon-size) shrink-0 items-center justify-center"
        role="img"
        aria-label={label}
      >
        {statusIcons[status]}
      </span>
    </Tip>
  )
}

// 所有会话行共用一个每分钟触发的时钟，避免每行各开一个定时器。
let minuteNow = Date.now()
const minuteListeners = new Set<() => void>()
let minuteTimer: ReturnType<typeof setInterval> | null = null
function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener)
  if (!minuteTimer) {
    minuteNow = Date.now()
    minuteTimer = setInterval(() => {
      minuteNow = Date.now()
      for (const notify of minuteListeners) notify()
    }, 60_000)
  }
  return () => {
    minuteListeners.delete(listener)
    if (!minuteListeners.size && minuteTimer) {
      clearInterval(minuteTimer)
      minuteTimer = null
    }
  }
}
function useMinuteNow(): number {
  return useSyncExternalStore(subscribeMinute, () => minuteNow)
}

function ThreadPreview({ thread, statusLabel }: { thread: ThreadSummary; statusLabel: string }) {
  const preview = threadPreviewText(thread)

  return (
    <>
      <span className="line-clamp-6 text-[length:var(--qn-session-font-size)] leading-[1.5] font-medium wrap-anywhere">{thread.title}</span>
      {preview && (
        <span className="mt-1 line-clamp-4 wrap-anywhere whitespace-pre-line text-qn-muted">{preview}</span>
      )}
      <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-qn-border pt-2 text-qn-muted">
        <span>{agentLabel(thread.agent)}</span>
        <span aria-hidden="true">·</span>
        <span>{statusLabel}</span>
        {thread.updatedAt > 0 && <span className="ml-auto">{t('更新于 {time}', { time: formatTime(thread.updatedAt) })}</span>}
      </span>
    </>
  )
}

function ShortcutItem({ hint, ...props }: ComponentProps<typeof ContextMenuItem>) {
  // 菜单打开时按快捷字母直接触发，见 onMenuKeyDown。
  return <ContextMenuItem hint={hint} data-shortcut={typeof hint === 'string' ? hint.toLowerCase() : undefined} {...props} />
}

/** 字母快捷键：找到带 data-shortcut 的项模拟点击，走 Radix 的 onSelect 并自动关闭菜单。 */
function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return
  const item = event.currentTarget.querySelector<HTMLElement>(
    `[data-shortcut="${event.key.toLowerCase()}"]:not([data-disabled])`,
  )
  if (!item) return
  event.preventDefault()
  item.click()
}

/**
 * 侧栏会话行：点击打开；悬停显示置顶/归档；右键菜单提供重命名、置顶、未读、分支、复制、归档、删除。
 * memo + 只订阅派生出的状态字符串：流式增量只改条目文本，状态不变时行不重渲染。
 */
export const ThreadRow = memo(function ThreadRow({
  thread,
  targetId,
  current,
  onActivate,
}: {
  thread: ThreadSummary
  targetId: string
  current: boolean
  onActivate: () => void
}) {
  const openThread = useCodex((s) => s.openThread)
  const opening = useCodex(({ openingThread }) => openingThread?.targetId === targetId
    && openingThread.agent === thread.agent && openingThread.threadId === thread.id)
  const renameThread = useCodex((s) => s.renameThread)
  const archiveThread = useCodex((s) => s.archiveThread)
  const deleteThread = useCodex((s) => s.deleteThread)
  const forkThread = useCodex((s) => s.forkThread)
  const key = threadKey(thread.agent, thread.id)
  const prefs = useThreadPrefs((s) => s.byTarget[targetId])
  const setPinned = useThreadPrefs((s) => s.setPinned)
  const setUnread = useThreadPrefs((s) => s.setUnread)
  const setLocalName = useThreadPrefs((s) => s.setLocalName)
  const forget = useThreadPrefs((s) => s.forget)

  const now = useMinuteNow()
  const pinned = prefs?.pinned[key] !== undefined
  const unread = prefs?.unread[key] === true && !current
  // 会话行只显示状态，正文增量无需重绘这一行。
  const activity = useCodex((s) => sessionStatus(
    s.sessions[sessionKey(targetId, thread.agent)]?.state.threads[thread.id], thread.activity, unread,
  ))
  // 查看结果后，侧栏用空闲状态表示会话正在等待下一条消息。
  const status = activity === 'completed' ? 'idle' : activity
  const statusLabel = opening ? t('正在打开会话') : sessionStatusLabels[status]
  const running = isActiveThread(status)
  const showActions = status !== 'pending' && status !== 'input'
  // Claude 侧没有会话管理 RPC：重命名/归档退化为本机记录，分支与永久删除不可用。
  const native = thread.agent === 'codex'

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(thread.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    // 等右键菜单关闭、焦点归还之后再聚焦，否则会被 Radix 抢回去。
    const timer = setTimeout(() => inputRef.current?.select(), 0)
    return () => clearTimeout(timer)
  }, [editing])

  const open = (): void => {
    onActivate()
    void openThread(thread.id, thread.agent)
  }

  const beginRename = (): void => {
    setDraft(thread.title)
    setEditing(true)
  }

  const commitRename = async (): Promise<void> => {
    setEditing(false)
    const name = draft.trim()
    if (!name || name === thread.title) return
    if (native) {
      if (await renameThread(thread.id, thread.agent, name)) setLocalName(targetId, key, null)
    } else {
      setLocalName(targetId, key, name)
    }
  }

  const archive = async (): Promise<void> => {
    await archiveThread(thread.id, thread.agent)
  }

  const remove = async (): Promise<void> => {
    setDeleting(true)
    const ok = await deleteThread(thread.id, thread.agent)
    setDeleting(false)
    setConfirmDelete(false)
    if (ok) forget(targetId, key)
  }

  const resumeCommand =
    thread.agent === DEFAULT_AGENT ? `codex resume ${thread.id}` : `claude --resume ${thread.id}`

  if (editing) {
    return (
      <div className="flex min-h-8 items-center pl-(--qn-tree-title-start) pr-1">
        <input
          ref={inputRef}
          value={draft}
          aria-label={t('会话名称')}
          className="qn-input min-h-7 min-w-0 flex-1 px-1.5 py-0 text-[length:var(--qn-session-font-size)] leading-tight"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commitRename()
            else if (event.key === 'Escape') setEditing(false)
          }}
        />
      </div>
    )
  }

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={`group flex min-h-8 w-full cursor-default items-center gap-(--qn-tree-row-inset) rounded-lg pl-(--qn-tree-row-inset) pr-2 text-[length:var(--qn-session-font-size)] leading-tight data-[state=open]:bg-qn-hover ${
              current ? 'bg-qn-active text-qn-text' : 'text-qn-text/80 hover:bg-qn-hover hover:text-qn-text'
            }`}
            onClick={(event) => {
              if (event.currentTarget.contains(event.target as Node)) open()
            }}
          >
            <ThreadStatusIcon status={opening ? 'opening' : status} label={statusLabel} />
            <Tip
              label={<ThreadPreview thread={thread} statusLabel={statusLabel} />}
              side="right"
              align="start"
              className="w-80 max-w-[calc(100vw-16px)] rounded-xl px-3 py-2.5"
            >
              <button
                type="button"
                aria-busy={opening}
                aria-current={current ? 'true' : undefined}
                className="flex min-w-0 flex-1 cursor-default items-center gap-2 self-stretch rounded-lg py-px text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-outline-hover"
                onKeyDown={(event) => {
                  if (event.key === 'F2') beginRename()
                }}
              >
                <span className={cn('min-w-0 flex-1 truncate', unread && 'text-qn-text')}>{thread.title}</span>
                {pinned && <Pin size={11} className="shrink-0 text-qn-dim" aria-label={t('已置顶')} />}
              </button>
            </Tip>
            {showActions && (
              <span className="hidden shrink-0 items-center group-hover:flex group-has-focus-visible:flex" onClick={(e) => e.stopPropagation()}>
                <IconButton
                  label={pinned ? t('取消置顶') : t('置顶')}
                  className="h-6 w-6"
                  onClick={() => setPinned(targetId, key, !pinned)}
                >
                  {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </IconButton>
                {!running && (
                  <IconButton label={t('归档')} className="h-6 w-6" onClick={() => void archive()}>
                    <Archive size={13} />
                  </IconButton>
                )}
              </span>
            )}
            {/* 悬停时让位给置顶/归档按钮。 */}
            {showActions && thread.updatedAt > 0 && (
              <span
                className="shrink-0 text-[length:var(--qn-session-detail-font-size)] text-qn-muted group-hover:hidden group-has-focus-visible:hidden"
                aria-hidden="true"
              >
                {formatRelative(thread.updatedAt, now)}
              </span>
            )}
            <AgentIcon agent={thread.agent} size={12} />
          </div>
        </ContextMenu.Trigger>
        <ContextMenuContent className="min-w-52" onKeyDown={onMenuKeyDown}>
          <ShortcutItem icon={<Pencil size={14} />} hint="R" onSelect={beginRename}>
            {t('重命名')}
          </ShortcutItem>
          <ShortcutItem
            icon={pinned ? <PinOff size={14} /> : <Pin size={14} />}
            hint="P"
            onSelect={() => setPinned(targetId, key, !pinned)}
          >
            {pinned ? t('取消置顶') : t('置顶')}
          </ShortcutItem>
          <ShortcutItem
            icon={unread ? <Eye size={14} /> : <EyeOff size={14} />}
            hint="U"
            disabled={current}
            onSelect={() => setUnread(targetId, key, !unread)}
          >
            {unread ? t('标记为已读') : t('标记为未读')}
          </ShortcutItem>
          <ContextMenuSeparator />
          <ShortcutItem
            icon={<GitBranch size={14} />}
            hint="X"
            disabled={!native || running}
            onSelect={() => {
              onActivate()
              void forkThread(thread.id, thread.agent)
            }}
          >
            {native ? t('创建聊天分支') : t('创建聊天分支（Claude 暂不支持）')}
          </ShortcutItem>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={cn(menuItemClass, 'text-qn-text')}>
              <MenuItemContent icon={<Copy size={14} />}>{t('复制')}</MenuItemContent>
              <ChevronRight size={14} className="shrink-0 text-qn-dim" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent sideOffset={6} className={cn(floatSurface, 'min-w-44 p-1')}>
                <ShortcutItem icon={<Copy size={14} />} onSelect={() => void copyText(thread.title)}>
                  {t('复制标题')}
                </ShortcutItem>
                <ShortcutItem icon={<Copy size={14} />} onSelect={() => void copyText(thread.id)}>
                  {t('复制会话 ID')}
                </ShortcutItem>
                <ShortcutItem icon={<Copy size={14} />} disabled={!thread.cwd} onSelect={() => void copyText(thread.cwd)}>
                  {t('复制工作目录')}
                </ShortcutItem>
                <ShortcutItem icon={<Copy size={14} />} onSelect={() => void copyText(resumeCommand)}>
                  {t('复制恢复命令')}
                </ShortcutItem>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenuSeparator />
          <ShortcutItem icon={<Archive size={14} />} hint="A" disabled={running} onSelect={() => void archive()}>
            {t('归档')}
          </ShortcutItem>
          <ShortcutItem
            icon={<Trash2 size={14} />}
            danger
            disabled={!native || running}
            onSelect={() => setConfirmDelete(true)}
          >
            {t('永久删除')}
          </ShortcutItem>
        </ContextMenuContent>
      </ContextMenu.Root>

      {confirmDelete && (
        <Modal
          title={t('永久删除会话？')}
          description={t('「{title}」及其全部记录将从 Codex 中删除，无法恢复。', { title: thread.title })}
          onClose={() => setConfirmDelete(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="qn-button-subtle"
                onClick={() => setConfirmDelete(false)}
              >
                {t('取消')}
              </button>
              <button
                type="button"
                disabled={deleting}
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                onClick={() => void remove()}
              >
                {deleting ? t('删除中…') : t('永久删除')}
              </button>
            </div>
          }
        >
          <p className="text-qn-muted">{t('如只是不想在列表里看到它，可以改用「归档」。')}</p>
        </Modal>
      )}
    </>
  )
})
