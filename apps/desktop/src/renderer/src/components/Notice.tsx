import { useEffect } from 'react'
import { useCodex } from '../store/codex'
import { useTargets } from '../store/targets'
import { FeedbackRow } from './FeedbackRow'

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

  return (
    <FeedbackRow
      message={message}
      className="qn-no-drag qn-pop qn-surface-float fixed right-4 top-12 z-40 max-w-sm px-3.5 py-2.5 text-ui leading-5"
      onClose={() => {
        dismissTargets()
        dismissCodex()
      }}
    />
  )
}
