import { isActiveThread, sessionStatus, sessionStatusLabels, type ThreadView } from '@qn/codex-client'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ComponentProps } from 'react'
import { ContextMenu } from 'radix-ui'
import {
  Archive,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { DEFAULT_AGENT } from '../../lib/agents'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { threadKey, type ThreadSummary } from '../../lib/threads'
import { formatRelative } from '../../lib/time'
import { useCodex } from '../../store/codex'
import { useThreadPrefs } from '../../store/threadPrefs'
import { AgentIcon } from '../AgentIcon'
import { LoadingIcon } from '../LoadingIcon'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, floatSurface, menuItemClass, MenuItemContent } from '../primitives'
import { IconButton, Modal } from '../ui'
import { SessionStatusBadge } from './SessionStatusBadge'

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

/** 侧栏会话行：点击打开；悬停显示置顶/归档；右键菜单提供重命名、置顶、未读、分支、复制、归档、删除。 */
export function ThreadRow({
  thread,
  now,
  current,
  view,
}: {
  thread: ThreadSummary
  now: number
  current: boolean
  view?: ThreadView
}) {
  const targetId = useCodex((s) => s.currentTargetId)
  const openThread = useCodex((s) => s.openThread)
  const renameThread = useCodex((s) => s.renameThread)
  const archiveThread = useCodex((s) => s.archiveThread)
  const deleteThread = useCodex((s) => s.deleteThread)
  const forkThread = useCodex((s) => s.forkThread)
  const key = threadKey(thread.agent, thread.id)
  const prefs = useThreadPrefs((s) => (targetId ? s.byTarget[targetId] : undefined))
  const setPinned = useThreadPrefs((s) => s.setPinned)
  const setUnread = useThreadPrefs((s) => s.setUnread)
  const setLocalName = useThreadPrefs((s) => s.setLocalName)
  const setHidden = useThreadPrefs((s) => s.setHidden)
  const forget = useThreadPrefs((s) => s.forget)

  const pinned = prefs?.pinned[key] !== undefined
  const unread = prefs?.unread[key] === true && !current
  const status = sessionStatus(view, thread.activity, unread)
  const running = isActiveThread(status)
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

  if (!targetId) return null

  const open = (): void => {
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
    if (native) {
      if (await archiveThread(thread.id, thread.agent)) setPinned(targetId, key, false)
    } else {
      setHidden(targetId, key, true)
      setPinned(targetId, key, false)
    }
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
      <div className="flex h-8 items-center pl-[25px] pr-1">
        <input
          ref={inputRef}
          value={draft}
          aria-label="会话名称"
          className="qn-input h-7 min-w-0 flex-1 px-1.5 py-0 text-[13px]"
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
            role="button"
            tabIndex={0}
            className={`group relative flex h-8 w-full cursor-default items-center gap-2 rounded-lg pl-[31px] pr-2 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover ${
              current ? 'bg-qn-active text-qn-text' : 'text-qn-text/80 hover:bg-qn-hover hover:text-qn-text'
            }`}
            title={thread.preview || thread.title}
            onClick={open}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open()
              } else if (event.key === 'F2') {
                beginRename()
              }
            }}
          >
            {status === 'running' ? (
              <LoadingIcon
                size={13}
                strokeWidth={2.5}
                className="absolute left-[14px] top-1/2 -mt-[6.5px] text-qn-brand [animation-duration:2s]"
                role="img"
                aria-hidden={false}
                aria-label={sessionStatusLabels.running}
              />
            ) : unread && (
              <span className="absolute left-[18px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-qn-brand" aria-label="未读" />
            )}
            {pinned && <Pin size={11} className="shrink-0 text-qn-dim" aria-label="已置顶" />}
            {thread.agent !== DEFAULT_AGENT && <AgentIcon agent={thread.agent} size={12} />}
            <span className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold text-qn-text')}>{thread.title}</span>
            <SessionStatusBadge status={status} />
            {status !== 'pending' && status !== 'input' && (
              <>
                <span className="shrink-0 text-[12px] text-qn-dim group-hover:hidden">
                  {formatRelative(thread.updatedAt, now)}
                </span>
                <span className="-mr-1 hidden shrink-0 items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
                  <IconButton
                    label={pinned ? '取消置顶' : '置顶'}
                    className="h-6 w-6"
                    onClick={() => setPinned(targetId, key, !pinned)}
                  >
                    {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                  </IconButton>
                  {!running && (
                    <IconButton label="归档" className="h-6 w-6" onClick={() => void archive()}>
                      <Archive size={13} />
                    </IconButton>
                  )}
                </span>
              </>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenuContent className="min-w-52" onKeyDown={onMenuKeyDown}>
          <ShortcutItem icon={<Pencil size={14} />} hint="R" onSelect={beginRename}>
            重命名
          </ShortcutItem>
          <ShortcutItem
            icon={pinned ? <PinOff size={14} /> : <Pin size={14} />}
            hint="P"
            onSelect={() => setPinned(targetId, key, !pinned)}
          >
            {pinned ? '取消置顶' : '置顶'}
          </ShortcutItem>
          <ShortcutItem
            icon={unread ? <Eye size={14} /> : <EyeOff size={14} />}
            hint="U"
            disabled={current}
            onSelect={() => setUnread(targetId, key, !unread)}
          >
            {unread ? '标记为已读' : '标记为未读'}
          </ShortcutItem>
          <ContextMenuSeparator />
          <ShortcutItem
            icon={<GitBranch size={14} />}
            hint="X"
            disabled={!native || running}
            onSelect={() => void forkThread(thread.id, thread.agent)}
          >
            {native ? '创建聊天分支' : '创建聊天分支（Claude 暂不支持）'}
          </ShortcutItem>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={cn(menuItemClass, 'text-qn-text')}>
              <MenuItemContent icon={<Copy size={14} />}>复制</MenuItemContent>
              <ChevronRight size={14} className="shrink-0 text-qn-dim" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent sideOffset={6} className={cn(floatSurface, 'min-w-44 p-1')}>
                <ShortcutItem icon={<Copy size={14} />} onSelect={() => void copyText(thread.title)}>
                  复制标题
                </ShortcutItem>
                <ShortcutItem icon={<Copy size={14} />} onSelect={() => void copyText(thread.id)}>
                  复制会话 ID
                </ShortcutItem>
                <ShortcutItem icon={<Copy size={14} />} disabled={!thread.cwd} onSelect={() => void copyText(thread.cwd)}>
                  复制工作目录
                </ShortcutItem>
                <ShortcutItem icon={<Copy size={14} />} onSelect={() => void copyText(resumeCommand)}>
                  复制恢复命令
                </ShortcutItem>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenuSeparator />
          <ShortcutItem icon={<Archive size={14} />} hint="A" disabled={running} onSelect={() => void archive()}>
            归档
          </ShortcutItem>
          <ShortcutItem
            icon={<Trash2 size={14} />}
            danger
            disabled={!native || running}
            onSelect={() => setConfirmDelete(true)}
          >
            永久删除
          </ShortcutItem>
        </ContextMenuContent>
      </ContextMenu.Root>

      {confirmDelete && (
        <Modal
          title="永久删除会话？"
          description={`「${thread.title}」及其全部记录将从 Codex 中删除，无法恢复。`}
          onClose={() => setConfirmDelete(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="qn-button-subtle"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={deleting}
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                onClick={() => void remove()}
              >
                {deleting ? '删除中…' : '永久删除'}
              </button>
            </div>
          }
        >
          <p className="text-qn-muted">如只是不想在列表里看到它，可以改用「归档」。</p>
        </Modal>
      )}
    </>
  )
}
