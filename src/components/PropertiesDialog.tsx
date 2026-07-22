import { useEffect, useMemo, useRef } from 'react'
import { Folder, File as FileIcon, LoaderCircle } from 'lucide-react'
import { usePropertiesStore } from '../store/propertiesStore'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { formatEntryCount, formatFileTime } from '../lib/fileProperties'
import { copyToClipboard } from '../utils/fileReferences'
import { formatBytes } from '../utils/formatBytes'
import { useProjectStore } from '../store/projectStore'

type PropertyRow = {
  key: string
  label: string
  hint?: string
  value?: string
  loading?: boolean
  isLocation?: boolean
}

type PropertySection = {
  key: string
  rows: PropertyRow[]
}

function RowLoading({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-muted" aria-busy="true">
      <LoaderCircle size={12} className="animate-spin text-accent" aria-hidden />
      {label}
    </span>
  )
}

function PropertyGrid({ rows, path }: { rows: PropertyRow[]; path: string }) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)

  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px] leading-snug">
      {rows.map(row => (
        <div key={row.key} className="contents">
          <dt className="whitespace-nowrap text-fg-muted">
            {row.hint ? (
              <Tooltip label={row.hint} side="bottom" wrapperClassName="inline-block">
                <span>{row.label}</span>
              </Tooltip>
            ) : (
              row.label
            )}
          </dt>
          <dd
            className={`m-0 min-w-0 text-fg ${
              row.isLocation
                ? 'cursor-pointer select-text rounded px-1 -mx-1 hover:bg-bg-hover hover:text-accent'
                : ''
            }`}
            onClick={
              row.isLocation
                ? () => {
                    void copyToClipboard(path)
                      .then(() => pushToast('success', t('路径已复制')))
                      .catch((err: unknown) => {
                        pushToast('error', t('复制路径失败: {error}', { error: String(err) }))
                      })
                  }
                : undefined
            }
          >
            {row.loading ? (
              <RowLoading label={t('加载中…')} />
            ) : row.isLocation ? (
              <Tooltip label={t('点击复制完整路径')} side="bottom" wrapperClassName="block min-w-0">
                <span className="break-all font-mono text-[12px] leading-relaxed">{row.value}</span>
              </Tooltip>
            ) : (
              <span className="break-all tabular-nums">{row.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Two-column properties sheet — sectioned grid, left-aligned label column. */
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

  const sections = useMemo((): PropertySection[] => {
    if (!properties) return []
    const countHint = t('含所有子文件夹')
    const general: PropertyRow[] = [
      { key: 'name', label: t('名称'), value: properties.name },
      {
        key: 'kind',
        label: t('类型'),
        value: properties.kind === 'folder' ? t('文件夹') : t('文件'),
      },
      { key: 'location', label: t('位置'), value: properties.location, isLocation: true },
    ]

    const stats: PropertyRow[] = []
    if (properties.kind === 'file') {
      stats.push({
        key: 'size',
        label: t('大小'),
        loading: metaLoading,
        value: metaLoading ? undefined : properties.size != null ? formatBytes(properties.size) : '—',
      })
    } else {
      stats.push(
        {
          key: 'size',
          label: t('大小'),
          hint: countHint,
          loading: countsLoading,
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
          hint: countHint,
          loading: countsLoading,
          value: countsLoading
            ? undefined
            : formatEntryCount(folderCounts?.fileCount, language),
        },
        {
          key: 'folder-count',
          label: t('文件夹数'),
          hint: countHint,
          loading: countsLoading,
          value: countsLoading
            ? undefined
            : formatEntryCount(folderCounts?.folderCount, language),
        },
      )
    }

    const times: PropertyRow[] = [
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
    ]

    return [
      { key: 'general', rows: general },
      { key: 'stats', rows: stats },
      { key: 'times', rows: times },
    ]
  }, [properties, folderCounts, metaLoading, countsLoading, t, language])

  if (!open || !properties) return null

  const KindIcon = properties.kind === 'folder' ? Folder : FileIcon

  return (
    <ModalOverlay onDismiss={close} zIndex="z-[110]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="properties-title"
        className="ui-font-scaled modal-content-enter relative w-full max-w-[440px] rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-active text-accent">
            <KindIcon size={18} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="properties-title"
              className="truncate text-[14px] font-semibold leading-tight text-fg"
            >
              {title}
            </h2>
            <p className="mt-0.5 text-[11px] text-fg-muted">{t('属性')}</p>
          </div>
        </div>

        <div className="px-4 py-3">
          {error && (
            <p className="mb-3 text-[13px] text-danger">{t('读取属性失败: {error}', { error })}</p>
          )}
          <div className="flex flex-col gap-3">
            {sections.map((section, index) => (
              <div
                key={section.key}
                className={index > 0 ? 'border-t border-border pt-3' : undefined}
              >
                <PropertyGrid rows={section.rows} path={properties.path} />
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <button
            ref={okRef}
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-accent/90"
            onClick={close}
          >
            {t('确定')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
