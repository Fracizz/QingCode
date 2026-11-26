import { contextUsage, formatTokens } from '@qn/codex-client'
import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { Button, Dialog } from './ui'

export function ContextUsage({ tokenUsage }: { tokenUsage: unknown }) {
  const [open, setOpen] = useState(false)
  const usage = contextUsage(tokenUsage)
  if (!usage) return null

  const label = `上下文已用 ${usage.percent}%`
  const color = usage.percent >= 90 ? 'text-qn-danger' : usage.percent >= 75 ? 'text-qn-warn' : 'text-qn-muted'
  return (
    <>
      <Button variant="ghost" className="qn-icon-button shrink-0 px-1!" aria-label={`查看上下文用量，${label}`} onClick={() => setOpen(true)}>
        <span className={`flex items-center gap-1 text-[11px] ${color}`} aria-hidden><Gauge size={16} />{usage.percent}%</span>
      </Button>
      {open && (
        <Dialog title="上下文用量" onClose={() => setOpen(false)}>
          <p className={`mb-2 text-sm ${color}`}>{label}</p>
          <progress className="mb-2 w-full accent-current" aria-label="上下文占用" max={100} value={usage.percent} />
          <p className="text-sm text-qn-muted">{formatTokens(usage.used)} / {formatTokens(usage.window)} tokens</p>
        </Dialog>
      )}
    </>
  )
}
