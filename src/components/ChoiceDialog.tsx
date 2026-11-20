import { lazy, Suspense } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { useChoiceStore } from '../store/choiceStore'
import ModalOverlay, { INTERRUPT_MODAL_Z } from './ModalOverlay'
import { useI18n } from '../lib/i18n'

const MarkdownRichText = lazy(() => import('./MarkdownRichText'))

export default function ChoiceDialog() {
  const { t } = useI18n()
  const request = useChoiceStore(s => s.request)
  const answer = useChoiceStore(s => s.answer)
  const progress = useChoiceStore(s => s.progress)
  if (progress) return (
    <ModalOverlay zIndex={INTERRUPT_MODAL_Z}>
      <div role="dialog" aria-modal="true" aria-label={t('退出 QingCode')}
        className="modal-panel modal-sm flex items-center gap-3 px-5 py-4">
        <LoaderCircle size={16} aria-hidden className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />
        <p role="status" className="text-ui text-fg">{progress}</p>
      </div>
    </ModalOverlay>
  )
  if (!request) return null

  const markdownDetail = Boolean(request.detailMarkdown && request.detail)
  const wideActions = request.wideActions
  const panelLayout = markdownDetail
    ? 'modal-lg flex max-h-[80vh] flex-col overflow-hidden'
    : wideActions
      ? 'modal-md max-h-[calc(100dvh-2rem)] overflow-y-auto'
      : 'modal-md'

  return (
    <ModalOverlay onDismiss={() => answer(null)} zIndex={INTERRUPT_MODAL_Z}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        aria-describedby="choice-message"
        className={`modal-panel modal-content-enter ${panelLayout} ${wideActions ? '@container/choice text-ui' : ''}`}
      >
        <div className={`flex gap-3.5 px-5 pt-5 pb-4 ${markdownDetail ? 'flex-shrink-0' : ''}`}>
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border/60 bg-warn/10 text-warn">
            <AlertTriangle size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="choice-title" className="text-ui-lg font-semibold text-fg">
              {t(request.title)}
            </h2>
            <p id="choice-message" className="mt-1.5 text-ui leading-relaxed text-fg">
              {t(request.message)}
            </p>
            {!markdownDetail && request.detail && (
              <p className="text-ui-sm mt-2.5 leading-relaxed text-fg-muted whitespace-pre-line [overflow-wrap:anywhere]">
                {request.detail}
              </p>
            )}
          </div>
        </div>
        {markdownDetail && request.detail && (
          <div className="min-h-0 flex-1 overflow-auto border-t border-border px-5 py-4">
            <Suspense fallback={null}>
              <MarkdownRichText content={request.detail} />
            </Suspense>
          </div>
        )}
        <div
          className={`flex gap-2 border-t border-border px-5 py-3.5 bg-bg-deep/20 rounded-b-lg ${
            wideActions
              ? 'flex-col [overflow-wrap:anywhere] @min-[32em]/choice:flex-row @min-[32em]/choice:justify-end'
              : 'flex-wrap justify-end'
          } ${
            markdownDetail ? 'flex-shrink-0' : ''
          }`}
        >
          {request.options.map((option, index) => {
            const isPrimary =
              option.primary || (!request.options.some(o => o.primary) && index === 0)
            return (
              <button
                key={option.id}
                type="button"
                data-modal-autofocus={isPrimary || undefined}
                className={
                  option.danger
                    ? 'btn btn-danger'
                    : isPrimary
                      ? 'btn btn-primary'
                      : 'btn btn-secondary'
                }
                onClick={() => answer(option.id)}
              >
                {t(option.label)}
              </button>
            )
          })}
        </div>
      </div>
    </ModalOverlay>
  )
}
