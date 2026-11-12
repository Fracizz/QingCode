import { toastDuration } from '../lib/toastTimers'
import { useI18n } from '../lib/i18n'
import { X, AlertCircle, Info, CheckCircle2 } from 'lucide-react'
import { useProjectStore, type Toast } from '../store/projectStore'
import { ProjectSourceBadge } from './ProjectName'
import TransferTasks from './TransferTasks'
import ServerOperationTasks from './ServerOperationTasks'

export default function Toaster() {
  const { t: translate } = useI18n()
  const pause = useProjectStore(s => s.pauseToast)
  const resume = useProjectStore(s => s.resumeToast)
  const toasts = useProjectStore(s => s.toasts)
  const dismiss = useProjectStore(s => s.dismissToast)

  return (
    <div data-floating-task-stack className="fixed bottom-8 right-3 z-[150] flex max-h-[calc(100dvh-4rem)] w-[min(428px,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto overscroll-contain p-1 empty:hidden [&>*]:shrink-0">
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
        const durationMs = toastDuration(t)
        return (
          <div
            key={t.id}
            onMouseEnter={() => pause(t.id, 'hover')}
            onMouseLeave={() => resume(t.id, 'hover')}
            onFocusCapture={() => pause(t.id, 'focus')}
            onBlurCapture={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) resume(t.id, 'focus')
            }}
            className="toast-enter toast-item relative overflow-hidden bg-bg-elevated border border-border-strong rounded-lg shadow-elevation-2 px-3.5 py-3 flex items-start gap-2.5 text-ui-lg w-80 max-w-full self-end [overflow-wrap:anywhere] transition-all duration-150 hover:shadow-elevation-3"
          >
            <Icon size={16} className={`${color} mt-0.5 flex-shrink-0`} />
            <div className="flex-1 min-w-0">
              <div role={t.kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
                <p className="font-medium text-fg leading-snug">{renderToastText(t)}</p>
                {t.detail ? (
                  <p className="text-ui-sm mt-1 leading-relaxed text-fg-muted">{t.detail}</p>
                ) : null}
              </div>
              {t.action ? (
                <button
                  type="button"
                  className="mt-2.5 inline-flex items-center rounded-md border border-border-strong bg-bg px-2.5 py-1 text-ui-sm font-medium text-fg shadow-sm transition-colors hover:bg-bg-hover hover:text-fg active:translate-y-[0.5px]"
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
              aria-label={translate('关闭通知')}
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
      <ServerOperationTasks />
      <TransferTasks />
    </div>
  )
}

/** 文案中的 `{project}` 换成「项目名 + 来源徽标」，与项目卡片标题保持一致。 */
function renderToastText(toast: Toast) {
  const subject = toast.subject
  if (!subject || !toast.text.includes('{project}')) return toast.text
  const [before, ...rest] = toast.text.split('{project}')
  return (
    <>
      {before}
      <span className="inline-flex max-w-full items-baseline gap-1.5 align-baseline">
        <span className="min-w-0">{subject.name}</span>
        {subject.source ? <ProjectSourceBadge source={subject.source} className="shrink text-ui-sm" /> : null}
      </span>
      {rest.join(subject.name)}
    </>
  )
}
