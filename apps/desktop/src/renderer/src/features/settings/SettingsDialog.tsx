import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bot,
  Info,
  Network,
  Search,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  X,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import type { SshTarget } from '../../../../shared/backendApi'
import { cn } from '../../lib/cn'
import { EmptyState, ErrorNote, IconButton, Spinner } from '../../components/ui'
import { AboutSection } from './AboutSection'
import { AgentSection } from './AgentSection'
import { ConnectionSection } from './ConnectionSection'
import { GeneralSection } from './GeneralSection'
import { MobileSection } from './MobileSection'
import { SectionHeading } from './fields'
import {
  SETTINGS_SECTIONS,
  SETTING_ITEMS,
  filterSettings,
  type SettingsSectionId,
} from './settingsModel'
import { useSettings } from './settingsStore'

export type SettingsDialogProps = {
  open: boolean
  onClose: () => void
  initialSection?: SettingsSectionId
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

/**
 * 全窗口设置模态（Codex 桌面版 / VS Code 形态）：左侧分类导航、右侧表单、顶部搜索过滤设置项。
 * 用原生 Radix Dialog 而非 ui.tsx 的 Modal，因为后者把高度封顶在 680px，无法铺满窗口。
 */
export function SettingsDialog({
  open,
  onClose,
  initialSection,
  onEditTarget,
  onRemoveTarget,
}: SettingsDialogProps) {
  const load = useSettings((state) => state.load)
  const loading = useSettings((state) => state.loading)
  const saving = useSettings((state) => state.saving)
  const error = useSettings((state) => state.error)
  const dismissError = useSettings((state) => state.dismissError)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SettingsSectionId>(initialSection ?? 'general')

  useEffect(() => {
    if (!open) return
    void load()
    setQuery('')
    if (initialSection) setActive(initialSection)
  }, [open, initialSection, load])

  const filter = useMemo(() => filterSettings(query), [query])
  const searching = filter.query.length > 0
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
        return <MobileSection />
      case 'about':
        return <AboutSection />
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="qn-no-drag fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="qn-no-drag fixed inset-4 z-50 flex flex-col overflow-hidden rounded-2xl border border-qn-border-strong bg-qn-panel text-[13px] text-qn-text shadow-[0_24px_80px_rgba(0,0,0,0.6)] outline-none"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-qn-border px-5 py-3">
            <Settings2 size={17} className="shrink-0 text-qn-brand" />
            <Dialog.Title className="text-[15px] font-semibold">设置</Dialog.Title>
            <div className="relative ml-auto w-72 max-w-[42vw] shrink">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-qn-dim" />
              <input
                className="qn-input pl-8 pr-8"
                aria-label="搜索设置"
                placeholder="搜索设置…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  aria-label="清空搜索"
                  className="absolute right-2 top-1.5 text-qn-dim hover:text-qn-text"
                  onClick={() => setQuery('')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭设置" tooltip={false} className="-mr-2">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </header>

          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="设置分类"
              className="qn-scroll w-52 shrink-0 overflow-y-auto border-r border-qn-border bg-qn-sidebar p-2"
            >
              <div className="space-y-0.5">
                {SETTINGS_SECTIONS.map((section) => {
                  const count = filter.sections.find((item) => item.id === section.id)?.itemIds.length ?? 0
                  const disabled = searching && count === 0
                  return (
                    <button
                      key={section.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setActive(section.id)
                        if (searching) setQuery('')
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                        active === section.id && !searching
                          ? 'bg-qn-hover text-qn-text'
                          : 'text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                        disabled && 'opacity-40',
                      )}
                    >
                      <span className="shrink-0 text-qn-muted"><SectionIcon id={section.id} /></span>
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                      {searching && <span className="text-[11px] text-qn-dim">{count}</span>}
                    </button>
                  )
                })}
              </div>
              <p className="mt-4 px-2.5 text-[11px] leading-5 text-qn-dim">
                修改即时保存到本机；检测只运行可执行文件的 --version。
              </p>
            </nav>

            <main className="qn-scroll min-w-0 flex-1 overflow-y-auto px-6 py-5">
              <ErrorNote message={error} onClose={dismissError} />
              {shown.length === 0 ? (
                <EmptyState>没有匹配的设置项，试试别的关键词。</EmptyState>
              ) : (
                shown.map(({ id, itemIds }) => {
                  const section = SETTINGS_SECTIONS.find((item) => item.id === id)
                  return (
                    <section key={id} id={`settings-section-${id}`} className="mb-8 last:mb-0">
                      <SectionHeading title={section?.label ?? id} description={section?.description} />
                      {renderSection(id, (itemId) => itemIds.includes(itemId))}
                    </section>
                  )
                })
              )}
            </main>
          </div>

          <footer className="flex shrink-0 items-center gap-3 border-t border-qn-border px-5 py-2 text-[12px] text-qn-dim">
            {loading ? <Spinner label="加载设置…" /> : saving ? <Spinner label="保存中…" /> : <span>设置自动保存</span>}
            <span className="ml-auto">Ctrl+, 打开设置</span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
