import { useEffect, useRef, useState } from 'react'
import { Copy, MoreHorizontal, Split } from 'lucide-react'
import { copyText } from '../lib/clipboard'
import { markdownToPlainText } from '../lib/markdown'

export function MessageActions({
  markdown,
  onFork,
}: {
  markdown: string
  onFork?: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: globalThis.MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setMenu(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  const copy = async (value: string, label: string) => {
    const ok = await copyText(value)
    setCopied(ok ? label : '复制失败')
    setMenu(false)
    window.setTimeout(() => setCopied(null), 1600)
  }

  return (
    <div ref={wrapperRef} className="relative mt-1 flex items-center gap-1 text-[11px] text-qn-muted">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/10 hover:text-white"
        title="复制 Markdown 原文"
        onClick={() => void copy(markdown, '已复制 Markdown')}
      >
        <Copy size={12} /> 复制
      </button>
      <button
        type="button"
        className="rounded px-1 py-0.5 hover:bg-white/10 hover:text-white"
        title="更多操作"
        aria-label="更多操作"
        onClick={() => setMenu((value) => !value)}
      >
        <MoreHorizontal size={13} />
      </button>
      {copied && <span className="text-emerald-300">{copied}</span>}
      {menu && (
        <div className="absolute left-0 top-6 z-20 w-48 rounded border border-qn-border bg-[#252525] py-1 text-xs shadow-xl">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-white/10"
            onClick={() => void copy(markdownToPlainText(markdown), '已复制纯文本')}
          >
            <Copy size={12} /> 复制为纯文本
          </button>
          {onFork && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-white/10"
              onClick={() => {
                setMenu(false)
                onFork()
              }}
            >
              <Split size={12} /> 从这里开始新会话
            </button>
          )}
        </div>
      )}
    </div>
  )
}
