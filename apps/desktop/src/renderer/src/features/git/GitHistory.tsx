import { memo, useCallback, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GitCommit } from '@qn/protocol'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GitCommitHorizontal,
} from 'lucide-react'
import { EmptyState, ErrorNote, IconButton, Spinner } from '../../components/ui'
import { RefreshIcon } from '../../components/LoadingIcon'
import { cn } from '../../lib/cn'
import { openDiff } from '../workspace/openers'
import {
  describeGitError,
  formatRelativeTime,
  joinRepoPath,
  repoKey,
  shortHash,
  statusInfo,
  type StatusTone,
} from './gitModel'
import { useGit, type GitCommitFile } from './gitStore'

const toneClass: Record<StatusTone, string> = {
  muted: 'text-qn-muted',
  accent: 'text-qn-accent',
  ok: 'text-qn-ok',
  warn: 'text-qn-warn',
  danger: 'text-qn-danger',
}

const EMPTY: GitCommit[] = []

export function GitHistory({ targetId, cwd }: { targetId: string; cwd: string }) {
  const key = repoKey(targetId, cwd)
  // 只订阅历史页用到的字段：工作区轮询变化不会重渲染提交列表。
  const state = useGit(
    useShallow((s) => {
      const repo = s.repos[key]
      return {
        commits: repo?.commits ?? EMPTY,
        commitFiles: repo?.commitFiles,
        hasMore: repo?.hasMore ?? false,
        logLoading: repo?.logLoading ?? false,
        loading: repo?.loading ?? false,
        historyError: repo?.historyError ?? null,
        operationError: repo?.operationError ?? null,
        root: repo?.status?.root ?? cwd,
      }
    }),
  )
  const refresh = useGit((s) => s.refresh)
  const loadMore = useGit((s) => s.loadMore)
  const loadCommitFiles = useGit((s) => s.loadCommitFiles)
  const clearError = useGit((s) => s.clearError)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const expandedRef = useRef<string | null>(null)

  const { commits, root } = state

  const toggle = useCallback(
    async (hash: string): Promise<void> => {
      // 用 ref 读当前展开项，回调保持稳定，行组件 memo 才有效。
      const opening = expandedRef.current !== hash
      expandedRef.current = opening ? hash : null
      setExpanded(expandedRef.current)
      if (!opening) return
      setFilesError(null)
      try {
        await loadCommitFiles(targetId, cwd, hash)
      } catch (err) {
        setFilesError(describeGitError(err, '读取提交文件失败').message)
      }
    },
    [loadCommitFiles, targetId, cwd],
  )

  const onScroll = (): void => {
    const node = listRef.current
    if (!node || !state.hasMore || state.logLoading) return
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 48) void loadMore(targetId, cwd)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-qn-border px-2 py-1.5">
        <span className="text-ui-sm text-qn-muted">提交历史</span>
        <IconButton label="刷新历史" className="h-7 w-7" onClick={() => void refresh(targetId, cwd)}>
          <RefreshIcon size={13} loading={state.loading} />
        </IconButton>
      </div>

      <div className="shrink-0 px-2 pt-1">
        <ErrorNote
          message={filesError ?? state.historyError ?? state.operationError}
          onClose={() => {
            setFilesError(null)
            clearError(targetId, cwd)
          }}
        />
      </div>

      <div ref={listRef} className="qn-scroll min-h-0 flex-1 overflow-y-auto py-1" onScroll={onScroll}>
        {state.loading && commits.length === 0 && <Spinner label="加载提交历史…" />}
        {!state.loading && commits.length === 0 && (
          <EmptyState>暂无提交。初始化仓库并提交后可在此查看历史。</EmptyState>
        )}
        {commits.map((item) => {
          const open = expanded === item.hash
          return (
            <CommitRow
              key={item.hash}
              item={item}
              open={open}
              files={open ? state.commitFiles?.[item.hash] : undefined}
              failed={open && filesError !== null}
              targetId={targetId}
              cwd={cwd}
              root={root}
              onToggle={toggle}
            />
          )
        })}

        {state.logLoading && <Spinner label="加载更多提交…" />}
        {state.hasMore && !state.logLoading && (
          <button
            type="button"
            className="mx-2 my-1 flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-ui-sm text-qn-muted hover:bg-qn-hover"
            onClick={() => void loadMore(targetId, cwd)}
          >
            <GitCommitHorizontal size={13} /> 加载更多
          </button>
        )}
      </div>
    </div>
  )
}

const CommitRow = memo(function CommitRow({
  item,
  open,
  files,
  failed,
  targetId,
  cwd,
  root,
  onToggle,
}: {
  item: GitCommit
  open: boolean
  files: GitCommitFile[] | undefined
  failed: boolean
  targetId: string
  cwd: string
  root: string
  onToggle: (hash: string) => Promise<void>
}) {
  return (
    <div className="mb-0.5">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent"
        onClick={() => void onToggle(item.hash)}
        title={item.hash}
      >
        {open ? (
          <ChevronDown size={13} className="mt-0.5 shrink-0 text-qn-dim" />
        ) : (
          <ChevronRight size={13} className="mt-0.5 shrink-0 text-qn-dim" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-sm leading-5 text-qn-text">{item.subject}</span>
          <span className="mt-0.5 flex items-center justify-between gap-2 text-ui-xs leading-4 text-qn-dim">
            <span className="min-w-0 truncate">{item.author} · {formatRelativeTime(item.date)}</span>
            <span className="shrink-0 font-mono">{shortHash(item.hash)}</span>
          </span>
        </span>
      </button>

      {open && (
        <div className="ml-5 border-l border-qn-border pl-2">
          {!files && !failed && <Spinner label="加载提交文件…" />}
          {files && files.length === 0 && (
            <div className="px-1 py-1.5 text-ui-xs text-qn-dim">该提交没有文件变更</div>
          )}
          {files?.map((file) => {
            const info = statusInfo(file.status)
            return (
              <button
                key={file.path}
                type="button"
                className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-ui-xs outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent"
                title={`查看 ${shortHash(item.hash)} 中的差异`}
                onClick={() =>
                  openDiff({
                    targetId,
                    cwd,
                    path: joinRepoPath(root, file.path),
                    mode: 'commit',
                    commit: item.hash,
                    title: `${shortHash(item.hash)} · ${file.path}`,
                  })
                }
              >
                <FileText size={12} className="shrink-0 text-qn-dim" />
                <span className="min-w-0 flex-1 truncate">
                  {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                </span>
                <span className={cn('shrink-0', toneClass[info.tone])}>{info.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})
