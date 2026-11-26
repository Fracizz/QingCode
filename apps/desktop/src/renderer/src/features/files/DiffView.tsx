import { useEffect, useMemo, useState } from 'react'
import { Columns2, FileText, Rows3 } from 'lucide-react'
import { ErrorNote, Spinner, EmptyState } from '../../components/ui'
import { cn } from '../../lib/cn'
import { parseUnifiedDiff } from './diffModel'
import { loadDiffSides, type DiffSides } from './diffSides'
import { MergeEditor } from './editor/MergeEditor'
import type { DiffMode, TabStatus } from './filesModel'
import { diffModeLabel } from './filesModel'

type Props = {
  diff: string
  status: TabStatus
  path: string
  targetId: string
  cwd?: string
  mode?: DiffMode
  commit?: string
  error?: string
  errorCode?: string
  notice?: string
  truncated?: boolean
  onRetry?: () => void
  onOpenFile?: () => void
  className?: string
}

const ROW_TONE: Record<string, string> = {
  add: 'bg-emerald-500/10 text-emerald-300',
  remove: 'bg-red-500/10 text-red-300',
  meta: 'text-qn-dim',
  context: 'text-qn-text/85',
}

/** text 模式、旧 server / 非仓库、数据加载失败时退回统一 diff 文本渲染。 */
function UnifiedDiffBody({
  diff,
  status,
  path,
  error,
  errorCode,
  onRetry,
  onOpenFile,
}: Pick<Props, 'diff' | 'status' | 'path' | 'error' | 'errorCode' | 'onRetry' | 'onOpenFile'>) {
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const canOpenInstead = errorCode === 'not_repo' || errorCode === 'git_missing'
  if (status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner label="读取差异…" />
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="min-h-0 flex-1 p-3">
        <ErrorNote message={error ?? '读取差异失败'} onRetry={onRetry} />
        {canOpenInstead && onOpenFile && (
          <button
            type="button"
            onClick={onOpenFile}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-qn-border-strong px-2.5 py-1 text-[12px] text-qn-text hover:bg-qn-hover"
          >
            <FileText size={13} />
            打开文件
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="qn-scroll min-h-0 flex-1 overflow-auto bg-[#141414] font-mono text-[12px] leading-5">
      {rows.length === 0 ? (
        <EmptyState>没有改动 · {path}</EmptyState>
      ) : (
        <div className="min-w-max py-1">
          {rows.map((row, index) => (
            <div key={index} className={cn('flex min-h-5 px-1', ROW_TONE[row.kind])}>
              <span className="w-11 shrink-0 select-none pr-2 text-right text-qn-dim">{row.oldLine ?? ''}</span>
              <span className="w-11 shrink-0 select-none border-r border-qn-border pr-2 text-right text-qn-dim">
                {row.newLine ?? ''}
              </span>
              <span className="whitespace-pre pl-2 pr-4">{row.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MergeDiffBody({
  request,
  layout,
  onError,
}: {
  request: Parameters<typeof loadDiffSides>[0]
  layout: 'side' | 'unified'
  onError: (message: string) => void
}) {
  const [sides, setSides] = useState<DiffSides | null>(null)
  const key = `${request.targetId}\u0000${request.path}\u0000${request.mode}\u0000${request.commit ?? ''}\u0000${request.diff}`

  useEffect(() => {
    let alive = true
    setSides(null)
    void loadDiffSides(request).then(
      (result) => {
        if (alive) setSides(result)
      },
      (err: unknown) => {
        if (alive) onError(err instanceof Error ? err.message : '读取差异两侧失败')
      },
    )
    return () => {
      alive = false
    }
    // key 覆盖目标/路径/模式/diff 变化；request 对象每次渲染都是新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!sides) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner label="读取差异两侧…" />
      </div>
    )
  }
  return (
    <>
      {layout === 'side' && (
        <div className="flex shrink-0 items-center gap-4 border-b border-qn-border px-3 py-1 text-[11px] text-qn-muted">
          <span className="flex-1 truncate">左 · {sides.oldLabel}</span>
          <span className="flex-1 truncate">右 · {sides.newLabel}</span>
        </div>
      )}
      <MergeEditor
        original={sides.original}
        modified={sides.modified}
        path={request.path}
        layout={layout}
        className="min-h-0 flex-1"
      />
    </>
  )
}

/**
 * worktree / staged / commit 用 MergeView 对比两侧（并排 / unifiedMergeView 可切换）；
 * text 模式与非仓库等错误仍用统一 diff 文本。
 */
export function DiffView({
  diff,
  status,
  path,
  targetId,
  cwd,
  mode = 'worktree',
  commit,
  error,
  errorCode,
  notice,
  truncated,
  onRetry,
  onOpenFile,
  className,
}: Props) {
  const [layout, setLayout] = useState<'side' | 'unified'>('side')
  const [mergeError, setMergeError] = useState<string | null>(null)
  const mergeKey = `${targetId}\u0000${cwd ?? ''}\u0000${path}\u0000${mode}\u0000${commit ?? ''}\u0000${diff}`
  useEffect(() => setMergeError(null), [mergeKey])

  const canMerge = mode !== 'text' && !!cwd && status === 'ready'
  const request = useMemo(
    () => ({ targetId, path, cwd: cwd ?? '', mode, commit, diff, diffTruncated: truncated }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergeKey, truncated],
  )

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {notice && (
        <div className="shrink-0 border-b border-qn-warn/30 bg-qn-warn/10 px-3 py-1.5 text-[12px] text-qn-warn">
          {notice}
        </div>
      )}
      {truncated && (
        <div className="shrink-0 border-b border-qn-border px-3 py-1 text-[12px] text-qn-dim">diff 内容已截断</div>
      )}
      {canMerge && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-qn-border px-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-qn-dim">{diffModeLabel(mode, commit)} · 只读</span>
          <button
            type="button"
            onClick={() => setLayout('side')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] hover:bg-qn-hover',
              layout === 'side' ? 'bg-qn-active text-qn-text' : 'text-qn-muted',
            )}
          >
            <Columns2 size={12} /> 并排
          </button>
          <button
            type="button"
            onClick={() => setLayout('unified')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] hover:bg-qn-hover',
              layout === 'unified' ? 'bg-qn-active text-qn-text' : 'text-qn-muted',
            )}
          >
            <Rows3 size={12} /> 统一
          </button>
        </div>
      )}
      {mergeError && (
        <div className="shrink-0 border-b border-qn-warn/30 bg-qn-warn/10 px-3 py-1.5 text-[12px] text-qn-warn">
          {mergeError} · 已退回 diff 文本
        </div>
      )}
      {canMerge && !mergeError ? (
        <MergeDiffBody key={mergeKey} request={request} layout={layout} onError={setMergeError} />
      ) : (
        <UnifiedDiffBody
          diff={diff}
          status={status}
          path={path}
          error={error}
          errorCode={errorCode}
          onRetry={onRetry}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  )
}
