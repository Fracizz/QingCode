import { useEffect, useMemo, useRef } from 'react'
import { basename, imageDataUrl, isImagePath } from '../fileLinks'
import { useApp } from '../store'
import { diffRows, formatBytes, numberLines, viewKind, type DiffRow } from '../viewer'
import { Badge, BottomClose, Button, Header, Loading, Note } from './ui'
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

  if (lines.length === 0) return <div className="py-6 text-center text-sm text-qn-muted">（空文件）</div>
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
  if (rows.length === 0) return <div className="py-6 text-center text-sm text-qn-muted">没有差异</div>
  return (
    <>
      {truncated && <Note message={`差异较长，仅显示前 ${rows.length} 行`} tone="warn" />}
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

/** 全屏只读查看页：只有查看与"加载更多"，没有任何编辑、保存、暂存、提交入口。 */
export function FileViewer() {
  const viewer = useApp((s) => s.viewer)
  const close = useApp((s) => s.closeViewer)
  const loadMore = useApp((s) => s.loadMoreFile)
  const openFile = useApp((s) => s.openFile)
  const openDiff = useApp((s) => s.openDiff)

  if (!viewer) return null
  const file = viewer.file
  const kind = file ? viewKind(file) : null
  const title = basename(viewer.path) || viewer.path
  const imageRequested = viewer.mode === 'file' && isImagePath(viewer.path)

  return (
    <div className="qn-viewer" data-image={imageRequested || undefined}
      role="dialog" aria-modal="true" aria-label={`查看 ${title}`}>
      <Header
        title={viewer.mode === 'diff' ? `差异 · ${title}` : title}
        subtitle={viewer.path}
        onBack={close}
        right={<Badge>只读</Badge>}
      />
      <div className={`qn-body qn-scroll${kind === 'image' ? ' flex flex-col' : ''}`}>
        {viewer.notice && <Note message={viewer.notice} tone="warn" />}
        {viewer.error && (
          <Note
            message={viewer.error}
            tone="error"
            actionLabel="重试"
            onAction={() =>
              void (viewer.mode === 'diff'
                ? openDiff({ path: viewer.path, diff: viewer.diffSource === 'card' ? viewer.diff : null })
                : file
                  ? loadMore()
                  : openFile({ path: viewer.path, ...(viewer.line ? { line: viewer.line } : {}) }))
            }
          />
        )}
        {viewer.loading && <Loading text={viewer.mode === 'diff' ? '正在读取差异…' : imageRequested ? '正在读取图片…' : '正在读取文件…'} />}

        {viewer.mode === 'diff' && viewer.diff !== null && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-qn-muted">
              <Badge tone={viewer.diffSource === 'git' ? 'accent' : 'muted'}>
                {viewer.diffSource === 'git' ? 'Git 工作区差异' : '改动卡片自带差异'}
              </Badge>
              {viewer.diffTruncated && <Badge tone="warn">已截断</Badge>}
              <Button
                variant="ghost"
                className="ml-auto px-3 py-1 text-xs"
                onClick={() => void openFile({ path: viewer.path })}
              >
                查看文件
              </Button>
            </div>
            <DiffView text={viewer.diff} />
          </>
        )}

        {viewer.mode === 'file' && file && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-qn-muted">
              <span>{formatBytes(file.size)}</span>
              {viewer.line && <span>· 第 {viewer.line} 行</span>}
              {file.truncated && <Badge tone="warn">已截断</Badge>}
            </div>
            {kind === 'image' && (
              <ZoomableImage key={file.path} src={imageDataUrl(file.content, file.path)} alt={title}
                className="rounded-lg border border-qn-border bg-qn-field p-2"
                error={<Note message="无法显示这张图片，文件内容可能不完整" tone="warn" />} />
            )}
            {kind === 'binary' && (
              <Note message="这是二进制文件，无法以文本显示。" />
            )}
            {kind === 'text' && <TextView content={file.content} line={viewer.line} />}
            {kind === 'text' && file.truncated && (
              <div className="mt-3 flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[11px] text-qn-muted">
                  已显示 {formatBytes(file.offset + file.length)} / {formatBytes(file.size)}
                </span>
                <Button onClick={() => void loadMore()} disabled={viewer.loadingMore}>
                  {viewer.loadingMore ? '加载中…' : '加载更多'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <BottomClose onClick={close} label="关闭文件" />
    </div>
  )
}
