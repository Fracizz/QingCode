import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, Eye, LocateFixed } from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { safeInvoke } from '../lib/tauri'
import { formatFileSize } from '../lib/fileSizePolicy'
import { copyToClipboard } from '../utils/fileReferences'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import type { EditorTab } from '../types'

const CHUNK_BYTES = 128 * 1024

type FileSlice = {
  offset: number
  len: number
  text: string
  eof: boolean
  file_size: number
}

interface Props {
  tab: EditorTab
}

export default function LargeFileViewer({ tab }: Props) {
  const { t } = useI18n()
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const setView = useUIStore(s => s.setView)
  const [text, setText] = useState('')
  const [offset, setOffset] = useState(0)
  const [sliceLen, setSliceLen] = useState(0)
  const [fileSize, setFileSize] = useState(tab.fileSize ?? 0)
  const [eof, setEof] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const loadSlice = useCallback(
    async (nextOffset: number) => {
      const id = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const slice = await safeInvoke<FileSlice>('读取文件片段', 'read_file_slice', {
          path: tab.path,
          offset: nextOffset,
          maxBytes: CHUNK_BYTES,
        })
        if (id !== requestId.current) return
        setText(slice.text)
        setOffset(slice.offset)
        setSliceLen(slice.len)
        setFileSize(slice.file_size)
        setEof(slice.eof)
      } catch (e) {
        if (id !== requestId.current) return
        setError(e instanceof Error ? e.message : String(e))
        setText('')
        setSliceLen(0)
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [tab.path],
  )

  useEffect(() => {
    void loadSlice(0)
  }, [loadSlice, tab.path])

  const windowEnd = Math.min(offset + sliceLen, fileSize)

  const goPrev = () => {
    if (offset <= 0 || loading) return
    void loadSlice(Math.max(0, offset - CHUNK_BYTES))
  }

  const goNext = () => {
    if (eof || loading) return
    void loadSlice(offset + CHUNK_BYTES)
  }

  const jumpPercent = (pct: number) => {
    if (fileSize <= 0 || loading) return
    const target = Math.min(
      Math.max(0, Math.floor((fileSize * pct) / 100)),
      Math.max(0, fileSize - 1),
    )
    void loadSlice(target)
  }

  const copyPath = async () => {
    try {
      await copyToClipboard(tab.path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-fg-muted">
        <Eye size={12} className="text-accent flex-shrink-0" aria-hidden />
        <span className="truncate">
          {t('只读预览')} · {formatFileSize(fileSize || tab.fileSize || 0)} ·{' '}
          {t('超过 100MB 的文件仅只读分块预览，不可编辑')}
        </span>
        <span className="ml-auto flex-shrink-0 font-mono text-fg-dim">
          {fileSize > 0
            ? `${formatFileSize(offset)} – ${formatFileSize(Math.max(windowEnd, offset))} / ${formatFileSize(fileSize)}`
            : '…'}
        </span>
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || offset <= 0}
          onClick={goPrev}
        >
          {t('上一块')}
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || eof}
          onClick={goNext}
        >
          {t('下一块')}
        </button>
        <div className="mx-1 h-3 w-px bg-border" />
        {[0, 25, 50, 75, 100].map(pct => (
          <button
            key={pct}
            type="button"
            className="rounded px-1.5 py-0.5 font-mono text-[11px] text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
            disabled={loading || fileSize <= 0}
            onClick={() => jumpPercent(pct === 100 ? 99 : pct)}
          >
            {pct}%
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 text-[12px]">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() => {
              setView('explorer')
              void revealFileInTree(tab.path)
            }}
          >
            <LocateFixed size={12} />
            {t('在资源管理器中定位')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() =>
              void revealItemInDir(tab.path).catch(error => {
                useProjectStore
                  .getState()
                  .pushToast(
                    'error',
                    t('在文件管理器中显示失败: {error}', { error: String(error) }),
                  )
              })
            }
          >
            <ExternalLink size={12} />
            {t('在文件管理器中显示')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() => void copyPath()}
          >
            <Copy size={12} />
            {t('复制路径')}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="pointer-events-none absolute right-3 top-2 text-[11px] text-fg-dim">
            {t('加载中…')}
          </div>
        )}
        {error ? (
          <div className="p-6 text-sm text-warn">{error}</div>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-5 text-fg">
            {text || (loading ? '' : t('（空）'))}
          </pre>
        )}
      </div>
    </div>
  )
}
