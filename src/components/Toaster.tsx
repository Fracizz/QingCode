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
        const durationMs = t.action ? 8000 : t.detail ? 6000 : 4000
        return (
          <div
            key={t.id}
            className="toast-enter toast-item relative overflow-hidden bg-bg-elevated border border-border-strong rounded-lg shadow-elevation-2 px-3.5 py-3 flex items-start gap-2.5 text-sm max-w-sm transition-all duration-150 hover:shadow-elevation-3"
          >
            {/* Left color indicator bar */}
            <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${barColor}`} aria-hidden="true" />
            <Icon size={16} className={`${color} mt-0.5 flex-shrink-0`} />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-fg leading-snug">{t.text}</p>
              {t.detail ? (
                <p className="text-ui-sm mt-1 leading-relaxed text-fg-muted">{t.detail}</p>
              ) : null}
              {t.action ? (
                <button
                  type="button"
                  className="mt-2.5 inline-flex items-center rounded-md border border-border-strong bg-bg px-2.5 py-1 text-[12px] font-medium text-fg shadow-sm transition-colors hover:bg-bg-hover hover:text-fg active:translate-y-[0.5px]"
                  onClick={() => {
                    dismiss(t.id)
                    void t.action?.onAction()
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="关闭通知"
              onClick={() => dismiss(t.id)}
              className="text-fg-dim hover:text-fg p-0.5 rounded transition-colors hover:bg-bg-hover flex-shrink-0"
            >
              <X size={14} />
            </button>
            <span
              aria-hidden="true"
              className={`toast-progress absolute bottom-0 left-0 h-[2px] opacity-80 ${barColor}`}
              style={{ animationDuration: `${durationMs}ms` }}
            />
          </div>
        )
      })}
    </div>
  )
}
