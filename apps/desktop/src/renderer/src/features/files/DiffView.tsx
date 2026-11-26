import { useMemo } from 'react'
import { FileText } from 'lucide-react'
import { ErrorNote, Spinner, EmptyState } from '../../components/ui'
import { cn } from '../../lib/cn'
import { parseUnifiedDiff } from './diffModel'

type Props = {
  diff: string
  status: 'loading' | 'ready' | 'error'
  path: string
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

/** 统一 diff：新旧行号两栏 + 增删着色；非仓库/git 缺失时给出"打开文件"入口。 */
export function DiffView({
  diff,
  status,
  path,
  error,
  errorCode,
  notice,
  truncated,
  onRetry,
  onOpenFile,
  className,
}: Props) {
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const canOpenInstead = errorCode === 'not_repo' || errorCode === 'git_missing'

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
      {status === 'loading' && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner label="读取差异…" />
        </div>
      )}
      {status === 'error' && (
        <div className="min-h-0 flex-1 p-3">
          <ErrorNote message={error ?? '读取差异失败'} onRetry={onRetry} />
          {canOpenInstead && onOpenFile && (
            <button
              type="button"
              onClick={onOpenFile}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-qn-border-strong px-2.5 py-1 text-[12px] text-qn-text hover:bg-qn-hover"
            >
              <FileText size={13} />
              打开文件
            </button>
          )}
        </div>
      )}
      {status === 'ready' && (
        <div className="qn-scroll min-h-0 flex-1 overflow-auto bg-[#141414] font-mono text-[12px] leading-5">
          {rows.length === 0 ? (
            <EmptyState>没有改动 · {path}</EmptyState>
          ) : (
            <div className="min-w-max py-1">
              {rows.map((row, index) => (
                <div key={index} className={cn('flex min-h-5 px-1', ROW_TONE[row.kind])}>
                  <span className="w-11 shrink-0 select-none pr-2 text-right text-qn-dim">
                    {row.oldLine ?? ''}
                  </span>
                  <span className="w-11 shrink-0 select-none border-r border-qn-border pr-2 text-right text-qn-dim">
                    {row.newLine ?? ''}
                  </span>
                  <span className="whitespace-pre pl-2 pr-4">{row.text || ' '}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
