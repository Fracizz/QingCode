import { useMemo, useState } from 'react'
import { Check, ChevronRight, CircleAlert, Copy } from 'lucide-react'
import { copyText } from '../lib/clipboard'
import { describeTurnError, splitLinks } from '../lib/turnError'

/** 对话失败提示：先给结论与建议，服务端原文折叠起来，链接可直接点开。 */
export function TurnErrorNote({ error, compact = false }: { error: string; compact?: boolean }) {
  const view = useMemo(() => describeTurnError(error), [error])
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  // 原文与说明相同时没必要再展开一份
  const hasRaw = view.raw !== view.detail

  const copy = async () => {
    if (await copyText(view.raw)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="rounded-lg border border-qn-danger/30 bg-qn-danger/10 px-3 py-2.5 text-ui leading-5">
      <div className="flex items-start gap-2">
        <CircleAlert size={15} className="mt-0.5 shrink-0 text-qn-danger" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-qn-danger">{view.title}</span>
            {view.status !== undefined && (
              <span className="rounded bg-qn-danger/15 px-1.5 font-mono text-ui-xs leading-5 text-qn-danger">
                {view.status}
              </span>
            )}
            {view.hint && <span className="text-ui-sm text-qn-warn">{view.hint}</span>}
          </div>
          {view.detail && (
            <p className={`mt-1 whitespace-pre-wrap break-words text-qn-text/80 ${compact ? 'line-clamp-4' : ''}`}>
              {splitLinks(view.detail).map((seg, i) =>
                seg.kind === 'link' ? (
                  <a
                    key={i}
                    href={seg.url}
                    target="_blank"
                    rel="noreferrer"
                    title={seg.url}
                    className="text-qn-accent underline underline-offset-2 hover:opacity-80"
                  >
                    {seg.label}
                  </a>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-3 text-ui-sm text-qn-muted">
            {hasRaw && (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 hover:text-qn-text"
                onClick={() => setShowRaw((v) => !v)}
              >
                <ChevronRight size={12} className={showRaw ? 'rotate-90 transition-transform' : 'transition-transform'} />
                原始错误
              </button>
            )}
            <button type="button" className="inline-flex items-center gap-1 hover:text-qn-text" onClick={() => void copy()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? '已复制' : '复制错误'}
            </button>
          </div>
          {hasRaw && showRaw && (
            <pre className="qn-scroll mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-qn-inset px-2 py-1.5 font-mono text-ui-xs leading-4 text-qn-muted">
              {view.raw}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
