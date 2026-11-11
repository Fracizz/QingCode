import { useCallback, type ReactNode } from 'react'
import type { SettingsCategoryId } from '../lib/settingsSearch'
export type { SettingsCategoryId } from '../lib/settingsSearch'

export function SettingsSection({
  id,
  title,
  children,
  onSectionRef,
}: {
  id: SettingsCategoryId
  title: string
  children: ReactNode
  onSectionRef: (id: SettingsCategoryId, node: HTMLElement | null) => void
}) {
  const setSectionRef = useCallback(
    (node: HTMLElement | null) => onSectionRef(id, node),
    [id, onSectionRef],
  )
  return (
    <section ref={setSectionRef} aria-labelledby={`settings-heading-${id}`} className="scroll-mt-4">
      <h2 id={`settings-heading-${id}`} className="text-ui-heading font-semibold text-fg mb-3 pb-2 border-b border-border">
        {title}
      </h2>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

export function SettingItem({
  title,
  description,
  locked,
  lockHint,
  layout = 'responsive',
  children,
}: {
  title: string
  description: string
  modified?: boolean
  locked?: boolean
  lockHint?: string
  layout?: 'responsive' | 'stacked'
  children: ReactNode
}) {
  return (
    <div
      className="relative"
    >
      <div className={`settings-item-row flex flex-col gap-2${layout === 'stacked' ? ' settings-item-stacked' : ''}`}>
        <div className="settings-item-copy min-w-0 flex-1">
          <div className="text-ui font-medium text-fg">{title}</div>
          <p className="text-ui-sm mt-1 leading-relaxed text-fg-muted break-words">{description}</p>
          {locked && lockHint && (
            <p className="text-ui-sm mt-1 text-warn break-words">{lockHint}</p>
          )}
        </div>
        <div className="settings-item-control min-w-0 w-full max-w-full pt-0.5">
          {children}
        </div>
      </div>
    </div>
  )
}
