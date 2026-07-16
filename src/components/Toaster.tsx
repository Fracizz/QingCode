import { X, AlertCircle, Info, CheckCircle2 } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'

export default function Toaster() {
  const toasts = useProjectStore(s => s.toasts)
  const dismiss = useProjectStore(s => s.dismissToast)

  return (
    <div className="fixed bottom-8 right-4 z-50 flex flex-col gap-2 w-80">
      {toasts.map(t => {
        const Icon =
          t.kind === 'error'
            ? AlertCircle
            : t.kind === 'success'
              ? CheckCircle2
              : Info
        const color =
          t.kind === 'error'
            ? 'text-danger'
            : t.kind === 'success'
              ? 'text-ok'
              : 'text-accent'
        return (
          <div
            key={t.id}
            className="toast-enter bg-bg-elevated border border-border-strong rounded-md shadow-lg px-3 py-2.5 flex items-start gap-2 text-sm"
          >
            <Icon size={16} className={`${color} mt-0.5 flex-shrink-0`} />
            <span className="flex-1 text-fg leading-snug break-words">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="text-fg-dim hover:text-fg flex-shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
