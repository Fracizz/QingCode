import { X, AlertCircle, Info, CheckCircle2 } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'

export default function Toaster() {
  const toasts = useProjectStore(s => s.toasts)
  const dismiss = useProjectStore(s => s.dismissToast)

  return (
    <div className="fixed bottom-8 right-4 z-50 flex flex-col gap-2 w-80 max-w-[min(20rem,calc(100vw-2rem))]">
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
        const barColor =
          t.kind === 'error'
            ? 'bg-danger'
            : t.kind === 'success'
              ? 'bg-ok'
              : 'bg-accent'
        // Mirrors the auto-dismiss timers in projectStore.pushToast.
        const durationMs = t.detail ? 6000 : 4000
        return (
          <div
            key={t.id}
            className="toast-enter relative overflow-hidden bg-bg-elevated border border-border-strong rounded-md shadow-lg px-3 py-2.5 flex items-start gap-2 text-sm max-w-sm"
          >
            {/* Left color indicator bar */}
            <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${barColor}`} aria-hidden="true" />
            <Icon size={16} className={`${color} mt-0.5 flex-shrink-0`} />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-fg leading-snug">{t.text}</p>
              {t.detail ? (
                <p className="text-ui-sm mt-1 leading-relaxed text-fg-muted">{t.detail}</p>
              ) : null}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-fg-dim hover:text-fg flex-shrink-0"
            >
              <X size={14} />
            </button>
            <span
              aria-hidden="true"
              className={`toast-progress absolute bottom-0 left-0 h-[2px] opacity-70 ${barColor}`}
              style={{ animationDuration: `${durationMs}ms` }}
            />
          </div>
        )
      })}
    </div>
  )
}
