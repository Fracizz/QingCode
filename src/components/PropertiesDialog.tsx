import { useEffect, useMemo, useRef } from 'react'
import { Info, LoaderCircle } from 'lucide-react'
import { usePropertiesStore } from '../store/propertiesStore'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { formatEntryCount, formatFileTime } from '../lib/fileProperties'
import { copyToClipboard } from '../utils/fileReferences'
import { formatBytes } from '../utils/formatBytes'

type PropertyRow = {
  key: string
  label: string
  title?: string
  value?: string
  loading?: boolean
  isLocation?: boolean
  tabular?: boolean
}

function RowLoading({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-muted" aria-busy="true">
      <LoaderCircle size={12} className="animate-spin text-accent" aria-hidden />
      {label}
    </span>
  )
}

/** UI sans mixes CJK + Latin metrics — pure digit/Latin values may need a tiny nudge. */
function valueNeedsLatinAlign(value: string | undefined): boolean {
  if (!value) return false
  // Datetime etc. mix CJK + digits — skip nudge; inherits --font-sans like labels.
  if (/[\u4e00-\u9fff]/.test(value)) return false
  return /[0-9A-Za-z]/.test(value)
}

/** Two-column properties sheet — header + divider rows, no cell backgrounds. */
export default function PropertiesDialog() {
  const { t, language } = useI18n()
  const open = usePropertiesStore(s => s.open)
  const metaLoading = usePropertiesStore(s => s.metaLoading)
  const countsLoading = usePropertiesStore(s => s.countsLoading)
  const title = usePropertiesStore(s => s.title)
  const properties = usePropertiesStore(s => s.properties)
  const folderCounts = usePropertiesStore(s => s.folderCounts)
  const error = usePropertiesStore(s => s.error)
  const close = usePropertiesStore(s => s.close)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    okRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  const rows = useMemo(() => {
    if (!properties) return []
    const countHint = t('含所有子文件夹')
    const items: PropertyRow[] = [
      { key: 'name', label: t('名称'), value: properties.name },
      {
        key: 'kind',
        label: t('类型'),
        value: properties.kind === 'folder' ? t('文件夹') : t('文件'),
      },
      { key: 'location', label: t('位置'), value: properties.location, isLocation: true },
    ]

    if (properties.kind === 'file') {
      items.push({
        key: 'size',
        label: t('大小'),
        loading: metaLoading,
        tabular: true,
        value:
          metaLoading
            ? undefined
            : properties.size != null
              ? formatBytes(properties.size)
              : '—',
      })
    }

    if (properties.kind === 'folder') {
      items.push(
        {
          key: 'size',
          label: t('大小'),
          title: countHint,
          loading: countsLoading,
          tabular: true,
          value:
            countsLoading
              ? undefined
              : folderCounts != null
                ? formatBytes(folderCounts.totalSize)
                : '—',
        },
        {
          key: 'file-count',
          label: t('文件数'),
          title: countHint,
          loading: countsLoading,
          tabular: true,
          value: countsLoading
            ? undefined
            : formatEntryCount(folderCounts?.fileCount, language),
        },
        {
          key: 'folder-count',
          label: t('文件夹数'),
          title: countHint,
          loading: countsLoading,
          tabular: true,
          value: countsLoading
            ? undefined
            : formatEntryCount(folderCounts?.folderCount, language),
        },
      )
    }

    items.push(
      {
        key: 'created',
        label: t('创建时间'),
        loading: metaLoading,
        value: metaLoading ? undefined : formatFileTime(properties.createdMs, language),
      },
      {
        key: 'modified',
        label: t('修改时间'),
        loading: metaLoading,
        value: metaLoading ? undefined : formatFileTime(properties.modifiedMs, language),
      },
    )
    return items
  }, [properties, folderCounts, metaLoading, countsLoading, t, language])

  if (!open || !properties) return null

  return (
    <ModalOverlay onDismiss={close} zIndex="z-[110]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="properties-title"
        className="ui-font-scaled modal-content-enter relative w-full max-w-[460px] rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-3 border-b border-border pb-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-active text-accent">
              <Info size={16} aria-hidden />
            </div>
            <h2
              id="properties-title"
              className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg"
            >
              {t('{name} 属性', { name: title })}
            </h2>
          </div>
          {error && (
            <p className="pt-3 text-[13px] text-danger">{t('读取属性失败: {error}', { error })}</p>
          )}
          <dl className={error ? 'pt-2' : 'pt-1'}>
            {rows.map(row => (
              <div
                key={row.key}
                className="flex gap-x-3 border-b border-border py-2.5 last:border-b-0"
              >
                <dt className="flex w-24 shrink-0 items-center justify-end font-[family-name:var(--font-sans)] text-[13px] font-normal leading-snug text-fg-muted">
                  {row.title ? (
                    <Tooltip label={row.title} side="bottom" wrapperClassName="inline-block">
                      <span>{row.label}</span>
                    </Tooltip>
                  ) : (
                    row.label
                  )}
                </dt>
                <dd
                  className={`m-0 flex min-w-0 flex-1 items-center font-[family-name:var(--font-sans)] text-[13px] leading-snug text-fg ${
                    !row.loading && valueNeedsLatinAlign(row.value)
                      ? 'translate-y-[0.05em]'
                      : ''
                  } ${row.isLocation ? 'cursor-pointer select-text hover:text-accent' : ''}`}
                  onClick={
                    row.isLocation
                      ? () => {
                          void copyToClipboard(properties.location)
                        }
                      : undefined
                  }
                >
                  {row.loading ? (
                    <RowLoading label={t('加载中…')} />
                  ) : row.isLocation ? (
                    <Tooltip
                      label={properties.path}
                      side="bottom"
                      wrapperClassName="block min-w-0"
                    >
                      <span className="break-all">{row.value}</span>
                    </Tooltip>
                  ) : (
                    <span className="break-all">{row.value}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            ref={okRef}
            type="button"
            className="px-3 py-1.5 text-[13px] rounded bg-accent hover:bg-accent/90 text-white transition-colors"
            onClick={close}
          >
            {t('确定')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
