import { t } from '@qn/codex-client'
import { Code, Download, Eye } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { startProjectDownload } from '../downloads'
import { basename, imageDataUrl, isImagePath } from '../fileLinks'
import { getWindowNativePort } from '../native'
import { projectFileLocation } from '../projectApi'
import { friendlyError } from '../state'
import { useApp } from '../store'
import { toast } from '../toast'
import type { Project } from '../types'
import { diffRows, formatBytes, isMarkdownPath, numberLines, parentDir, viewKind, type DiffRow } from '../viewer'
import { FileActionsContext, Markdown, type FileActions } from './MessageItem'
import { Badge, Button, Header, Loading, LoadingIcon, Note } from './ui'
import { ZoomableImage } from './ZoomableImage'

const DIFF_CLASS: Record<DiffRow['kind'], string> = {
  add: 'qn-diff-add',
  remove: 'qn-diff-remove',
  hunk: 'qn-diff-hunk',
  meta: 'qn-diff-meta',
  context: '',
}

function TextView({ content, line }: { content: string; line: number | null }) {
  const lines = useMemo(() => numberLines(content), [content])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!line) return
    // 目标行在已加载范围内才滚动；否则停在顶部，由"加载更多"补齐。
    ref.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' })
  }, [line, lines.length])

  if (lines.length === 0) return <div className="py-6 text-center text-sm text-qn-muted">{t('（空文件）')}</div>
  return (
    <div ref={ref} className="qn-code qn-scroll">
      {lines.map((row) => (
        <div key={row.no} data-line={row.no} className={`qn-code-row ${row.no === line ? 'qn-code-row-hit' : ''}`}>
          <span className="qn-code-no">{row.no}</span>
          <span className="qn-code-text">{row.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

export function DiffView({ text }: { text: string }) {
  const { rows, truncated } = useMemo(() => diffRows(text), [text])
  if (rows.length === 0) return <div className="py-6 text-center text-sm text-qn-muted">{t('没有差异')}</div>
  return (
    <>
      {truncated && <Note message={t('差异较长，仅显示前 {count} 行', { count: rows.length })} tone="warn" />}
      <div className="qn-code qn-scroll">
        {rows.map((row, index) => (
          <div key={index} className={`qn-code-row ${DIFF_CLASS[row.kind]}`}>
            <span className="qn-code-no">{row.kind === 'add' ? row.newNo : (row.oldNo ?? '')}</span>
            <span className="qn-code-text">{row.text || ' '}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function FileDownloadButton({ desktopId, project, path, name, size }: {
  desktopId: string; project: Project; path: string; name: string; size: number
}) {
  const [starting, setStarting] = useState(false)

  async function download() {
    setStarting(true)
    try {
      await startProjectDownload(desktopId, project, { path, name, size })
    } catch (error) {
      toast(friendlyError(error, t('下载失败')), { tone: 'error' })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Button variant="ghost" className="ml-auto shrink-0 px-3 text-xs" onClick={() => void download()} disabled={starting}>
      {starting ? <LoadingIcon size={16} /> : <Download size={16} strokeWidth={1.75} aria-hidden />}
      {t('下载')}
    </Button>
  )
}

/** 全屏只读查看页，可下载项目内的原文件。 */
export function FileViewer() {
  const viewer = useApp((s) => s.viewer)
  const desktopId = useApp((s) => s.activeId)
  const projects = useApp((s) => s.projects)
  const close = useApp((s) => s.closeViewer)
  const loadMore = useApp((s) => s.loadMoreFile)
  const openFile = useApp((s) => s.openFile)
  const openDiff = useApp((s) => s.openDiff)
  // 记下用户手动切换过视图的文件；换文件后自动回到默认视图。
  const [flipped, setFlipped] = useState<string | null>(null)
  const viewKey = viewer ? `${viewer.path}:${viewer.line ?? ''}` : ''
  const markdownActions = useMemo<FileActions | null>(() => viewer?.mode === 'file' ? {
    cwd: parentDir(viewer.path),
    openFile: (location) => void openFile(location),
    openDiff: (path, diff) => void openDiff({ path, diff: diff ?? null }),
  } : null, [viewer?.mode, viewer?.path, openFile, openDiff])

  if (!viewer) return null
  const file = viewer.file
  const kind = file ? viewKind(file) : null
  const title = basename(viewer.path) || viewer.path
  const download = desktopId && file && viewer.mode === 'file' && getWindowNativePort()
    ? projectFileLocation(projects, viewer.targetId, viewer.path)
    : null
  const imageRequested = viewer.mode === 'file' && isImagePath(viewer.path)
  const markdown = viewer.mode === 'file' && kind === 'text' && isMarkdownPath(viewer.path)
  // Markdown 默认预览；带行号跳转时默认源码，才能定位到目标行。
  const preview = markdown && (!viewer.line) !== (flipped === viewKey)

  return (
    <div className="qn-viewer" data-image={imageRequested || undefined}
      role="dialog" aria-modal="true" aria-label={t('查看 {name}', { name: title })}>
      <Header
        title={viewer.mode === 'diff' ? t('差异 · {name}', { name: title }) : title}
        subtitle={viewer.path}
        onBack={close}
        right={(
          <>
            {markdown && (
              <Button variant="ghost" className="qn-header-icon" aria-pressed={!preview}
                aria-label={preview ? t('查看源码') : t('Markdown 预览')}
                onClick={() => setFlipped(flipped === viewKey ? null : viewKey)}>
                {preview ? <Code size={19} aria-hidden /> : <Eye size={19} aria-hidden />}
              </Button>
            )}
            <Badge>{t('只读')}</Badge>
          </>
        )}
      />
      <div className={`qn-body qn-scroll${kind === 'image' ? ' flex flex-col' : ''}`}>
        {viewer.notice && <Note message={viewer.notice} tone="warn" />}
        {viewer.error && (viewer.mode === 'diff' ? <Note message={viewer.error} tone="warn" /> : (
          <Note
            message={viewer.error}
            tone="error"
            actionLabel={t('重试')}
            onAction={() => void (file ? loadMore() : openFile({ path: viewer.path, ...(viewer.line ? { line: viewer.line } : {}) }))}
          />
        ))}
        {viewer.loading && <Loading text={imageRequested ? t('正在读取图片…') : t('正在读取文件…')} />}

        {viewer.mode === 'diff' && viewer.diff !== null && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-qn-muted">
              {viewer.diffTruncated && <Badge tone="warn">{t('已截断')}</Badge>}
              <Button
                variant="ghost"
                className="ml-auto px-3 py-1 text-xs"
                onClick={() => void openFile({ path: viewer.path })}
              >
                {t('查看文件')}
              </Button>
            </div>
            <DiffView text={viewer.diff} />
          </>
        )}

        {viewer.mode === 'file' && file && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-qn-muted">
              <span>{formatBytes(file.size)}</span>
              {viewer.line && <span>{t('· 第 {line} 行', { line: viewer.line })}</span>}
              {file.truncated && <Badge tone="warn">{t('已截断')}</Badge>}
              {desktopId && download && (
                <FileDownloadButton key={JSON.stringify([desktopId, viewer.targetId, download.project.id, download.path])}
                  desktopId={desktopId} project={download.project} path={download.path} name={title} size={file.size} />
              )}
            </div>
            {kind === 'image' && (
              <ZoomableImage key={file.path} src={imageDataUrl(file.content, file.path)} alt={title}
                error={<Note message={t('无法显示这张图片，文件内容可能不完整')} tone="warn" />} />
            )}
            {kind === 'binary' && (
              <Note message={t('这是二进制文件，无法以文本显示。')} />
            )}
            {preview && (
              <FileActionsContext.Provider value={markdownActions}>
                <div className="qn-markdown qn-markdown-file break-words text-sm">
                  <Markdown text={file.content} streaming={false} />
                </div>
              </FileActionsContext.Provider>
            )}
            {kind === 'text' && !preview && <TextView content={file.content} line={viewer.line} />}
            {kind === 'text' && file.truncated && (
              <div className="mt-3 flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[11px] text-qn-muted">
                  {t('已显示 {shown} / {total}', { shown: formatBytes(file.offset + file.length), total: formatBytes(file.size) })}
                </span>
                <Button onClick={() => void loadMore()} disabled={viewer.loadingMore}>
                  {viewer.loadingMore ? t('加载中…') : t('加载更多')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
