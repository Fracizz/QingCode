import type { RefObject } from 'react'
import { useI18n } from '../lib/i18n'

/** 终端标签栏与工作台列表共用的行内重命名框。 */
export default function TerminalRenameInput({
  terminalId,
  draft,
  inputRef,
  committingRef,
  onDraftChange,
  onCommit,
  onCancel,
  className,
}: {
  terminalId: string
  draft: string
  inputRef: RefObject<HTMLInputElement | null>
  committingRef: RefObject<boolean>
  onDraftChange: (value: string) => void
  onCommit: (id: string) => void
  onCancel: () => void
  className: string
}) {
  const { t } = useI18n()
  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onClick={event => event.stopPropagation()}
      onChange={event => onDraftChange(event.target.value)}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit(terminalId)
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => {
        window.setTimeout(() => {
          if (!committingRef.current) onCommit(terminalId)
        }, 80)
      }}
      className={className}
      aria-label={t('重命名终端')}
    />
  )
}
