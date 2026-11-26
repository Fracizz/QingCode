import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitFileStatus } from '@qn/protocol'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  ChevronDown,
  Copy,
  Diff,
  Download,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RotateCw,
  RotateCcw,
  Search,
} from 'lucide-react'
import { Badge, Checkbox, EmptyState, ErrorNote, IconButton, Modal, Spinner } from '../../components/ui'
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  Tip,
} from '../../components/primitives'
import { copyText } from '../../lib/clipboard'
import { cn } from '../../lib/cn'
import { openDiff, openFile } from '../workspace/openers'
import { GitHistory } from './GitHistory'
import {
  aheadBehindText,
  branchLabel,
  discardPrompt,
  filePaths,
  filterBranches,
  gitGroups,
  groupStatusFiles,
  isUntracked,
  joinRepoPath,
  pathsFor,
  remoteCheckoutName,
  repoKey,
  statusInfo,
  statusLetter,
  validateCommitMessage,
  type GitGroupKey,
  type StatusTone,
} from './gitModel'
import { startGitPolling, useGit } from './gitStore'

const toneClass: Record<StatusTone, string> = {
  muted: 'text-qn-muted',
  accent: 'text-qn-accent',
  ok: 'text-qn-ok',
  warn: 'text-qn-warn',
  danger: 'text-qn-danger',
}

type ContextMenu = { x: number; y: number; file: GitFileStatus; group: GitGroupKey }

export function GitPanel({ targetId, cwd }: { targetId: string; cwd: string }) {
  const key = repoKey(targetId, cwd)
  const state = useGit((s) => s.repos[key])
  const refresh = useGit((s) => s.refresh)
  const clearError = useGit((s) => s.clearError)
  const stage = useGit((s) => s.stage)
  const unstage = useGit((s) => s.unstage)
  const discard = useGit((s) => s.discard)
  const commit = useGit((s) => s.commit)
  const switchBranch = useGit((s) => s.switchBranch)
  const fetch = useGit((s) => s.fetch)
  const pull = useGit((s) => s.pull)
  const push = useGit((s) => s.push)

  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [discardFiles, setDiscardFiles] = useState<GitFileStatus[] | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const [visible, setVisible] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)

  const status = state?.status ?? null
  const branches = state?.branches ?? null
  const busy = Boolean(state?.operation)
  const error = state?.operationError ?? state?.error ?? null
  const root = status?.root ?? cwd
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const groups = useMemo(() => groupStatusFiles(status?.files ?? []), [status?.files])
  const total = groups.conflicts.length + groups.staged.length + groups.unstaged.length
  const check = validateCommitMessage(message)
  const blocked = state?.errorCode === 'not_repo' || state?.errorCode === 'git_missing'

  useEffect(() => {
    void refresh(targetId, cwd)
  }, [targetId, cwd, refresh])

  // CSS 隐藏（切到其他侧栏页）时也停止轮询，避免后台空转请求。
  useEffect(() => {
    const node = rootRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries[0]?.isIntersecting ?? true)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    return startGitPolling(targetId, cwd)
  }, [targetId, cwd, visible])

  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const openRowDiff = (file: GitFileStatus, group: GitGroupKey): void => {
    const mode: 'worktree' | 'staged' = group === 'staged' ? 'staged' : 'worktree'
    openDiff({ targetId, cwd, path: joinRepoPath(root, file.path), mode })
  }

  const submit = async (): Promise<void> => {
    if (!check.ok || busy) return
    const ok = await commit(targetId, cwd, message.trim(), amend)
    if (ok) {
      setMessage('')
      setAmend(false)
    }
  }

  const selectBranch = async (name: string, remote: boolean): Promise<void> => {
    const branch = remote ? remoteCheckoutName(name) : name
    if (!branch || busy) return
    setBranchOpen(false)
    await switchBranch(targetId, cwd, branch)
  }

  const createBranch = async (): Promise<void> => {
    const branch = newBranch.trim()
    if (!branch || busy) return
    setBranchOpen(false)
    setNewBranch('')
    await switchBranch(targetId, cwd, branch, true)
  }

  const confirmDiscard = (): void => {
    const files = discardFiles
    if (!files) return
    setDiscardFiles(null)
    void discard(targetId, cwd, pathsFor(files), files.some(isUntracked))
  }

  const localBranches = filterBranches(branches?.local ?? [], branchQuery)
  const remoteBranches = filterBranches(branches?.remote ?? [], branchQuery)
  const current = status?.branch ?? branches?.current ?? null

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col bg-qn-panel text-qn-text"
      onClick={() => setMenu(null)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-qn-border px-2 py-2">
        <PopoverRoot
          open={branchOpen}
          onOpenChange={(open) => {
            setBranchOpen(open)
            if (!open) {
              setBranchQuery('')
              setNewBranch('')
            }
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 max-w-[52%] items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover"
            >
              <GitBranch size={14} className="shrink-0 text-qn-muted" />
              <span className="truncate">{branchLabel(current)}</span>
              <ChevronDown size={13} className="shrink-0 text-qn-dim" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="flex max-h-[min(70vh,480px)] w-80 flex-col overflow-hidden p-0" align="start">
            <div className="flex shrink-0 items-center gap-2 border-b border-qn-border px-3 py-2">
              <Search size={14} className="shrink-0 text-qn-dim" />
              <input
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-qn-dim"
                placeholder="搜索分支"
                value={branchQuery}
                onChange={(event) => setBranchQuery(event.target.value)}
              />
            </div>
            <div className="qn-scroll min-h-0 flex-1 overflow-y-auto p-1" role="listbox">
              <div className="px-2.5 py-1 text-[11px] text-qn-dim">本地分支</div>
              {localBranches.length === 0 && (
                <div className="px-2.5 py-1.5 text-[12px] text-qn-dim">无匹配分支</div>
              )}
              {localBranches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  aria-selected={branch.name === current}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] outline-none hover:bg-qn-hover focus-visible:bg-qn-hover"
                  onClick={() => void selectBranch(branch.name, false)}
                >
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.name === current && <Check size={13} className="shrink-0 text-qn-brand" />}
                </button>
              ))}
              <div className="mt-1 border-t border-qn-border px-2.5 py-1 text-[11px] text-qn-dim">远端分支</div>
              {remoteBranches.length === 0 && (
                <div className="px-2.5 py-1.5 text-[12px] text-qn-dim">无匹配分支</div>
              )}
              {remoteBranches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] outline-none hover:bg-qn-hover focus-visible:bg-qn-hover"
                  onClick={() => void selectBranch(branch.name, true)}
                >
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                </button>
              ))}
            </div>
            <div className="shrink-0 border-t border-qn-border p-2">
              <div className="mb-1 text-[11px] text-qn-dim">新建分支（基于当前 HEAD）</div>
              <div className="flex gap-1.5">
                <input
                  className="qn-input h-7 py-0 text-[12px]"
                  placeholder="分支名"
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void createBranch()
                  }}
                />
                <button
                  type="button"
                  className="qn-button-subtle shrink-0 px-2 py-1 text-[12px]"
                  disabled={!newBranch.trim() || busy}
                  onClick={() => void createBranch()}
                >
                  新建
                </button>
              </div>
            </div>
          </PopoverContent>
        </PopoverRoot>

        {(ahead > 0 || behind > 0) && (
          <Tip label={aheadBehindText(ahead, behind)}>
            <span className="shrink-0 font-mono text-[11px] text-qn-accent">
              {ahead > 0 && `↑${ahead}`} {behind > 0 && `↓${behind}`}
            </span>
          </Tip>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label="抓取远端更新（fetch）" className="h-7 w-7" disabled={busy || !status} onClick={() => void fetch(targetId, cwd)}>
            <Download size={14} />
          </IconButton>
          <IconButton label={`拉取（pull）${ahead || behind ? ` · ${aheadBehindText(ahead, behind)}` : ''}`} className="h-7 w-7" disabled={busy || !status} onClick={() => void pull(targetId, cwd)}>
            <ArrowDown size={14} />
          </IconButton>
          <IconButton label={`推送（push）${ahead || behind ? ` · ${aheadBehindText(ahead, behind)}` : ''}`} className="h-7 w-7" disabled={busy || !status} onClick={() => void push(targetId, cwd)}>
            <ArrowUp size={14} />
          </IconButton>
          <IconButton label="刷新" className="h-7 w-7" disabled={state?.loading} onClick={() => void refresh(targetId, cwd)}>
            <RotateCw size={14} className={state?.loading ? 'animate-spin' : ''} />
          </IconButton>
        </div>
      </div>

      <div className="shrink-0 px-2 pt-2">
        <ErrorNote
          message={error}
          onRetry={() => void refresh(targetId, cwd)}
          onClose={() => clearError(targetId, cwd)}
        />
      </div>

      {blocked ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState>
            {state?.errorCode === 'git_missing'
              ? '未找到 git：请在目标机器安装 Git 后点击刷新。'
              : '当前目录不是 Git 仓库。请切换到仓库内目录，或先在远端初始化仓库。'}
          </EmptyState>
        </div>
      ) : (
        <TabsRoot defaultValue="changes" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 border-b border-qn-border px-2 py-1">
            <TabsTrigger value="changes" className="flex items-center gap-1.5">
              <Diff size={13} /> 变更
              {total > 0 && <Badge tone="accent">{total}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="history" className="flex items-center gap-1.5">
              <History size={13} /> 历史
            </TabsTrigger>
          </TabsList>

          <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-qn-border px-2 py-2">
              <textarea
                className="qn-input min-h-[64px] resize-none text-[12px]"
                placeholder={`提交信息（Ctrl+Enter 提交${amend ? '，修改上次提交' : ''}）`}
                value={message}
                disabled={busy}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.ctrlKey || event.metaKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <Checkbox checked={amend} onChange={setAmend} disabled={busy}>
                  修改上次提交
                </Checkbox>
                <button
                  type="button"
                  className="qn-button ml-auto flex items-center gap-1 px-3 py-1 text-[12px]"
                  disabled={!check.ok || busy}
                  onClick={() => void submit()}
                >
                  {state?.operation === 'commit' ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <GitCommitHorizontal size={13} />
                  )}
                  提交
                </button>
              </div>
              {check.error && <div className="mt-1 text-[11px] text-qn-danger">{check.error}</div>}
              {check.warning && <div className="mt-1 text-[11px] text-qn-warn">{check.warning}</div>}
            </div>

            <div className="qn-scroll min-h-0 flex-1 overflow-y-auto py-1" onScroll={() => setMenu(null)}>
              {state?.loading && !status && <Spinner label="读取 Git 状态…" />}
              {!state?.loading && total === 0 && status && (
                <EmptyState>工作区干净，没有待提交的改动。</EmptyState>
              )}
              {gitGroups.map((group) => {
                const files = groups[group.key]
                if (files.length === 0) return null
                return (
                  <section key={group.key} className="mb-1.5">
                    <div className="flex items-center gap-1.5 px-2 py-1">
                      <span className="text-[12px] font-medium">{group.label}</span>
                      <Badge>{files.length}</Badge>
                      <div className="ml-auto flex items-center gap-0.5">
                        {group.key !== 'staged' && (
                          <IconButton
                            label={`全部暂存${group.label}`}
                            className="h-6 w-6"
                            disabled={busy}
                            onClick={() => void stage(targetId, cwd, pathsFor(files))}
                          >
                            <Plus size={13} />
                          </IconButton>
                        )}
                        {group.key === 'staged' && (
                          <IconButton
                            label="全部取消暂存"
                            className="h-6 w-6"
                            disabled={busy}
                            onClick={() => void unstage(targetId, cwd, pathsFor(files))}
                          >
                            <Minus size={13} />
                          </IconButton>
                        )}
                      </div>
                    </div>
                    {files.map((file) => {
                      const letter = statusLetter(file, group.key)
                      const info = statusInfo(letter)
                      const label = file.origPath ? `${file.origPath} → ${file.path}` : file.path
                      return (
                        <div
                          key={`${group.key}:${file.path}`}
                          className="group flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-qn-hover"
                          onContextMenu={(event) => {
                            event.preventDefault()
                            const rect = rootRef.current?.getBoundingClientRect()
                            setMenu({
                              x: event.clientX - (rect?.left ?? 0),
                              y: event.clientY - (rect?.top ?? 0),
                              file,
                              group: group.key,
                            })
                          }}
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-qn-accent"
                            onClick={() => openRowDiff(file, group.key)}
                            title="查看差异"
                          >
                            <span
                              className={cn('w-4 shrink-0 text-center font-mono text-[12px]', toneClass[info.tone])}
                              title={info.label}
                            >
                              {letter.trim() === '.' ? '·' : letter.trim()}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
                          </button>
                          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                            {group.key !== 'staged' && (
                              <IconButton
                                label="暂存"
                                className="h-6 w-6"
                                disabled={busy}
                                onClick={() => void stage(targetId, cwd, filePaths(file))}
                              >
                                <Plus size={12} />
                              </IconButton>
                            )}
                            {group.key === 'staged' && (
                              <IconButton
                                label="取消暂存"
                                className="h-6 w-6"
                                disabled={busy}
                                onClick={() => void unstage(targetId, cwd, filePaths(file))}
                              >
                                <Minus size={12} />
                              </IconButton>
                            )}
                            <IconButton
                              label="放弃更改"
                              danger
                              className="h-6 w-6"
                              disabled={busy}
                              onClick={() => setDiscardFiles([file])}
                            >
                              <RotateCcw size={12} />
                            </IconButton>
                          </span>
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>
          </TabsContent>

          <TabsContent value="history" className="min-h-0 flex-1 overflow-hidden">
            <GitHistory targetId={targetId} cwd={cwd} />
          </TabsContent>
        </TabsRoot>
      )}

      {menu && (
        <div
          className="qn-surface-float absolute z-30 w-44 p-1 text-[12px]"
          style={{
            left: Math.max(0, Math.min(menu.x, (rootRef.current?.clientWidth ?? 400) - 180)),
            top: menu.y,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-qn-hover"
            onClick={() => {
              openFile({ targetId, path: joinRepoPath(root, menu.file.path) })
              setMenu(null)
            }}
          >
            <FileText size={13} className="text-qn-muted" /> 打开文件
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-qn-hover"
            onClick={() => {
              void copyText(joinRepoPath(root, menu.file.path))
              setMenu(null)
            }}
          >
            <Copy size={13} className="text-qn-muted" /> 复制路径
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-qn-hover"
            onClick={() => {
              openRowDiff(menu.file, menu.group)
              setMenu(null)
            }}
          >
            <Diff size={13} className="text-qn-muted" /> 查看差异
          </button>
        </div>
      )}

      {discardFiles && (
        <Modal
          title="放弃更改？"
          description={
            discardFiles.some(isUntracked)
              ? '未跟踪文件将被删除，且不可恢复'
              : '此操作不可撤销'
          }
          onClose={() => setDiscardFiles(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={() => setDiscardFiles(null)}>
                取消
              </button>
              <button
                type="button"
                className="qn-button flex items-center gap-1"
                disabled={busy}
                onClick={confirmDiscard}
              >
                <RotateCcw size={14} /> 确认放弃
              </button>
            </div>
          }
        >
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-5 text-qn-muted">
            {discardPrompt(discardFiles)}
          </pre>
          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-qn-danger">
            <CircleAlert size={13} /> 放弃前请确认没有需要保留的改动
          </div>
        </Modal>
      )}
    </div>
  )
}
