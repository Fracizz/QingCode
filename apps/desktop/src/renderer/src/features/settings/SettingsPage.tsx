import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  Info,
  Network,
  SlidersHorizontal,
  Smartphone,
} from 'lucide-react'
import { t } from '@qn/codex-client'
import type { SshTarget } from '../../../../shared/backendApi'
import { cn } from '../../lib/cn'
import { MobileSettings } from '../../components/MobileSettings'
import { SearchField } from '../../components/SearchField'
import { EmptyState, ErrorNote, Spinner } from '../../components/ui'
import { AboutSection } from './AboutSection'
import { AgentSection } from './AgentSection'
import { ConnectionSection } from './ConnectionSection'
import { GeneralSection } from './GeneralSection'
import { closeSettings, openSettings, useSettingsDialog } from './dialogState'
import { SectionHeading } from './fields'
import {
  SETTINGS_SECTIONS,
  SETTING_ITEMS,
  filterSettings,
  type SettingsSectionId,
} from './settingsModel'
import { useSettings } from './settingsStore'

export type SettingsPageProps = {
  /** 编辑连接表单由宿主提供；不传时只隐藏编辑按钮。 */
  onEditTarget?: (target: SshTarget) => void
  /** 删除连接由宿主确认后执行；不传时只隐藏删除按钮。 */
  onRemoveTarget?: (id: string) => void
}

function SectionIcon({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case 'general':
      return <SlidersHorizontal size={15} />
    case 'agents':
      return <Bot size={15} />
    case 'connections':
      return <Network size={15} />
    case 'mobile':
      return <Smartphone size={15} />
    case 'about':
      return <Info size={15} />
  }
}

export function SettingsPage({
  onEditTarget,
  onRemoveTarget,
}: SettingsPageProps) {
  const load = useSettings((state) => state.load)
  const loading = useSettings((state) => state.loading)
  const saving = useSettings((state) => state.saving)
  const error = useSettings((state) => state.error)
  const dismissError = useSettings((state) => state.dismissError)

  const active = useSettingsDialog((state) => state.section) ?? 'general'
  const [query, setQuery] = useState('')
  const titleRef = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
    titleRef.current?.focus({ preventScroll: true })
  }, [load])

  useEffect(() => {
    setQuery('')
  }, [active])

  const filter = useMemo(() => filterSettings(query), [query])
  const searching = filter.query.length > 0
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [active, filter.query])

  const shown = searching
    ? filter.sections
    : SETTINGS_SECTIONS.filter((section) => section.id === active).map((section) => ({
        id: section.id,
        itemIds: SETTING_ITEMS.filter((item) => item.section === section.id).map((item) => item.id),
      }))

  const renderSection = (id: SettingsSectionId, visible: (itemId: string) => boolean): ReactNode => {
    switch (id) {
      case 'general':
        return <GeneralSection visible={visible} />
      case 'agents':
        return <AgentSection visible={visible} />
      case 'connections':
        return <ConnectionSection onEditTarget={onEditTarget} onRemoveTarget={onRemoveTarget} />
      case 'mobile':
        return <MobileSettings />
      case 'about':
        return <AboutSection />
    }
  }

  return (
    <main
      aria-labelledby="settings-title"
      className="flex min-h-0 flex-1 flex-col bg-qn-bg text-ui text-qn-text"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
        event.preventDefault()
        if (query) setQuery('')
        else closeSettings()
      }}
    >
      <header className="flex shrink-0 items-center gap-4 border-y border-qn-border bg-qn-sidebar px-5 py-3">
        <button
          type="button"
          className="qn-button-subtle flex shrink-0 items-center gap-2"
          onClick={closeSettings}
        >
          <ArrowLeft size={15} aria-hidden="true" />
          {t('返回工作区')}
        </button>
        <h1 id="settings-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          {t('设置')}
        </h1>
        <div className="ml-auto text-qn-muted" role="status">
          {loading ? <Spinner label={t('加载设置…')} /> : saving ? <Spinner label={t('保存中…')} /> : null}
        </div>
        <SearchField
          boxed
          className="w-72 max-w-[40vw] shrink"
          label={t('搜索设置')}
          placeholder={t('搜索设置…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={query ? () => setQuery('') : undefined}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t('设置分类')}
          className="qn-scroll w-48 shrink-0 space-y-1 overflow-y-auto border-r border-qn-border bg-qn-sidebar px-3 py-4"
        >
          {SETTINGS_SECTIONS.map((section) => {
            const count = filter.sections.find((item) => item.id === section.id)?.itemIds.length ?? 0
            const disabled = searching && count === 0
            const current = active === section.id && !searching
            return (
              <button
                key={section.id}
                type="button"
                disabled={disabled}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  setQuery('')
                  openSettings(section.id)
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                  current
                    ? 'border-qn-border bg-qn-active font-medium text-qn-text'
                    : 'border-transparent text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                )}
              >
                <span aria-hidden="true" className={cn('shrink-0', current ? 'text-qn-brand' : 'text-qn-muted')}>
                  <SectionIcon id={section.id} />
                </span>
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                {searching && count > 0 && <span className="text-ui-xs text-qn-muted">{count}</span>}
              </button>
            )
          })}
        </nav>

        <div ref={scrollRef} className="qn-scroll min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-8 py-6">
            <ErrorNote message={error} onClose={dismissError} />
            {shown.length === 0 ? (
              <EmptyState>{t('没有匹配的设置项，试试别的关键词。')}</EmptyState>
            ) : (
              shown.map(({ id, itemIds }) => {
                const section = SETTINGS_SECTIONS.find((item) => item.id === id)
                return (
                  <section key={id} className="mb-8 last:mb-0">
                    <SectionHeading title={section?.label ?? id} description={section?.description} />
                    {renderSection(id, (itemId) => itemIds.includes(itemId))}
                  </section>
                )
              })
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
