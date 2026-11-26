import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useCodex } from '../store/codex'
import { useTargets } from '../store/targets'

export function Notice() {
  const targetNotice = useTargets((s) => s.notice)
  const codexNotice = useCodex((s) => s.notice)
  const dismissTargets = useTargets((s) => s.dismissNotice)
  const dismissCodex = useCodex((s) => s.clearNotice)
  const message = targetNotice ?? codexNotice

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => {
      dismissTargets()
      dismissCodex()
    }, 4000)
    return () => clearTimeout(timer)
  }, [message, dismissTargets, dismissCodex])

  if (!message) return null
  return (
    <div className="fixed bottom-9 right-4 z-40 flex max-w-sm items-start gap-2 rounded-lg border border-qn-border-strong bg-qn-elevated px-3 py-2 text-xs shadow-xl">
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{message}</span>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => {
          dismissTargets()
          dismissCodex()
        }}
      >
        <X size={13} />
      </button>
    </div>
  )
}
