import { useEffect, type MutableRefObject, type ReactNode } from 'react'

export type SettingsCategoryId =
  | 'common'
  | 'appearance'
  | 'editor'
  | 'terminal'
  | 'ai'
  | 'features'
  | 'language'
  | 'json'

export function SettingsSection({
  id,
  title,
  children,
  sectionRefs,
  onVisible,
}: {
  id: SettingsCategoryId
  title: string
  children: ReactNode
  sectionRefs: MutableRefObject<Partial<Record<SettingsCategoryId, HTMLElement | null>>>
  onVisible: (id: SettingsCategoryId) => void
}) {
  useEffect(() => {
    const el = sectionRefs.current[id]
    if (!el) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) onVisible(id)
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, onVisible, sectionRefs])

  return (
    <section
      ref={node => {
        sectionRefs.current[id] = node
      }}
      className="scroll-mt-4"
    >
      <h2 className="text-[18px] font-semibold text-fg mb-3 pb-2 border-b border-border">
        {title}
      </h2>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

export function SettingItem({
  title,
  description,
  modified,
  locked,
  lockHint,
  children,
}: {
  title: string
  description: string
  modified?: boolean
  locked?: boolean
  lockHint?: string
  children: ReactNode
}) {
  return (
    <div
      className={`relative pl-3 ${modified ? 'border-l-2 border-accent' : 'border-l-2 border-transparent'} ${
        locked ? 'opacity-70' : ''
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-[12rem] flex-1 basis-0">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          <p className="text-ui-sm mt-1 leading-relaxed text-fg-muted break-words">{description}</p>
          {locked && lockHint && (
            <p className="text-ui-sm mt-1 text-warn break-words">{lockHint}</p>
          )}
        </div>
        <div className="w-full sm:w-auto sm:max-w-[min(100%,320px)] sm:flex-shrink-0 pt-0.5">
          {children}
        </div>
      </div>
    </div>
  )
}
