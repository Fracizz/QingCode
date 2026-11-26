import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GitCommitHorizontal,
  RotateCw,
} from 'lucide-react'
import { EmptyState, ErrorNote, IconButton, Spinner } from '../../components/ui'
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
import { useGit } from './gitStore'

const toneClass: Record<StatusTone, string> = {
  muted: 'text-qn-muted',
  accent: 'text-qn-accent',
  ok: 'text-qn-ok',
  warn: 'text-qn-warn',
  danger: 'text-qn-danger',
}

export function GitHistory({ targetId, cwd }: { targetId: string; cwd: string }) {
  const key = repoKey(targetId, cwd)
  const state = useGit((s) => s.repos[key])
  const refresh = useGit((s) => s.refresh)
  const loadMore = useGit((s) => s.loadMore)
  const loadCommitFiles = useGit((s) => s.loadCommitFiles)
  const clearError = useGit((s) => s.clearError)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commits = state?.commits ?? []
  const root = state?.status?.root ?? cwd

  const toggle = async (hash: string): Promise<void> => {
    if (expanded === hash) {
      setExpanded(null)
      return
    }
    setExpanded(hash)
    setFilesError(null)
    if (state?.commitFiles[hash]) return
    try {
      await loadCommitFiles(targetId, cwd, hash)
    } catch (err) {
      setFilesError(describeGitError(err, '读取提交文件失败').message)
    }
  }

  const onScroll = (): void => {
    const node = listRef.current
    if (!node || !state?.hasMore || state.logLoading) return
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 48) void loadMore(targetId, cwd)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-qn-border px-2 py-1.5">
        <span className="text-[12px] text-qn-muted">提交历史</span>
        <IconButton label="刷新历史" className="h-7 w-7" onClick={() => void refresh(targetId, cwd)}>
          <RotateCw size={13} className={state?.loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      <div className="shrink-0 px-2 pt-1">
        <ErrorNote
          message={filesError ?? state?.historyError ?? state?.operationError ?? null}
          onClose={() => {
            setFilesError(null)
            clearError(targetId, cwd)
          }}
        />
      </div>

      <div ref={listRef} className="qn-scroll min-h-0 flex-1 overflow-y-auto py-1" onScroll={onScroll}>
        {state?.loading && commits.length === 0 && <Spinner label="加载提交历史…" />}
        {!state?.loading && commits.length === 0 && (
          <EmptyState>暂无提交。初始化仓库并提交后可在此查看历史。</EmptyState>
        )}
        {commits.map((item) => {
          const open = expanded === item.hash
          const files = state?.commitFiles[item.hash]
          return (
            <div key={item.hash} className="mb-0.5">
              <button
                type="button"
                className="flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent"
                onClick={() => void toggle(item.hash)}
                title={item.hash}
              >
                {open ? (
                  <ChevronDown size={13} className="mt-0.5 shrink-0 text-qn-dim" />
                ) : (
                  <ChevronRight size={13} className="mt-0.5 shrink-0 text-qn-dim" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] leading-5 text-qn-text">{item.subject}</span>
                  <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] leading-4 text-qn-dim">
                    <span className="min-w-0 truncate">{item.author} · {formatRelativeTime(item.date)}</span>
                    <span className="shrink-0 font-mono">{shortHash(item.hash)}</span>
                  </span>
                </span>
              </button>

              {open && (
                <div className="ml-5 border-l border-qn-border pl-2">
                  {!files && !filesError && <Spinner label="加载提交文件…" />}
                  {files && files.length === 0 && (
                    <div className="px-1 py-1.5 text-[11px] text-qn-dim">该提交没有文件变更</div>
                  )}
                  {files?.map((file) => {
                    const info = statusInfo(file.status)
                    return (
                      <button
                        key={file.path}
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-qn-accent"
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
        })}

        {state?.logLoading && <Spinner label="加载更多提交…" />}
        {state?.hasMore && !state.logLoading && (
          <button
            type="button"
            className="mx-2 my-1 flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-qn-muted hover:bg-qn-hover"
            onClick={() => void loadMore(targetId, cwd)}
          >
            <GitCommitHorizontal size={13} /> 加载更多
          </button>
        )}
      </div>
    </div>
  )
}
