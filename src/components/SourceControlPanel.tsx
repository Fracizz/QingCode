import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileDiff, GitBranch, RefreshCw } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { notifyGitStatusUpdated, type GitChange, type GitStatus } from '../lib/git'
import { isTauri, safeInvoke } from '../lib/tauri'
import Tooltip from './Tooltip'
import { translate, useI18n } from '../lib/i18n'

function absoluteFilePath(projectPath: string, relativePath: string) {
  const root = projectPath.replace(/[\\/]+$/, '')
  const rel = relativePath.replace(/\//g, '\\')
  return `${root}\\${rel}`
}

function statusClass(status: string) {
  if (status.includes('D')) return 'text-danger'
  if (status === '??' || status.includes('A') || status.includes('R') || status.includes('C')) {
    return 'text-ok'
  }
  return 'text-warn'
}

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-fg-muted'
  if (line.startsWith('+')) return 'text-ok'
  if (line.startsWith('-')) return 'text-danger'
  if (line.startsWith('@@')) return 'text-accent'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
    return 'text-fg-dim'
  }
  return 'text-fg-muted'
}

function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <span key={index} className={`block ${diffLineClass(line)}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

export default function SourceControlPanel() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffRequestId = useRef(0)

  const refresh = useCallback(async () => {
    if (!currentProject) {
      setStatus(null)
      setError(null)
      return
    }
    if (!isTauri()) {
      setError(translate('Git 功能需要 Tauri 桌面环境'))
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      const next = await safeInvoke<GitStatus>('读取 Git 状态', 'git_status', {
        path: currentProject.path,
      })
      setStatus(next)
      setError(null)
      setSelected(null)
      setDiff(null)
      notifyGitStatusUpdated()
    } catch (reason) {
      setStatus(null)
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [currentProject?.path])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const showDiff = async (change: GitChange) => {
    if (!currentProject) return
    const abs = absoluteFilePath(currentProject.path, change.path)
    const requestId = ++diffRequestId.current
    setSelected(change.path)
    setDiffLoading(true)
    setDiff(null)
    // Open the side-by-side compare in the main editor (VS Code-like).
    void useEditorStore.getState().openDiff(currentProject.path, change.path, abs)
    try {
      const text = await safeInvoke<string>('读取 Git 差异', 'git_diff', {
        path: currentProject.path,
        file: abs,
      })
      if (requestId !== diffRequestId.current) return
      setDiff(text || t('该文件当前没有可显示的差异。'))
    } catch (reason) {
      if (requestId !== diffRequestId.current) return
      setDiff(t('读取差异失败：{error}', { error: String(reason) }))
    } finally {
      if (requestId === diffRequestId.current) setDiffLoading(false)
    }
  }

  let body: ReactNode
  if (!currentProject) {
    body = <div className="px-4 py-6 text-[13px] text-fg-muted">{t('请先选择或添加项目')}</div>
  } else if (error) {
    body = <div className="px-4 py-3 text-[12px] leading-relaxed text-danger">{error}</div>
  } else if (status && !status.is_repository) {
    body = <div className="px-4 py-6 text-[13px] text-fg-muted">{t('当前项目不是 Git 仓库')}</div>
  } else if (status) {
    body = (
      <>
        <div className="border-y border-border px-4 py-2 text-[12px] text-fg-muted">
          <div className="flex items-center gap-1.5 text-fg">
            <GitBranch size={13} className="text-accent" />
            <span>{status.branch ?? t('游离 HEAD')}</span>
          </div>
          <p className="mt-1">{t('{count} 个更改', { count: status.changes.length })}</p>
        </div>
        {status.changes.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-fg-muted">{t('工作区没有未提交的更改')}</div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="max-h-[42%] overflow-auto border-b border-border py-1">
              {status.changes.map(change => (
                <button
                  key={`${change.status}-${change.path}`}
                  type="button"
                  onClick={() => void showDiff(change)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover ${
                    selected === change.path ? 'bg-bg-active' : ''
                  }`}
                >
                  <span className={`w-5 flex-shrink-0 font-mono font-semibold ${statusClass(change.status)}`}>
                    {change.status}
                  </span>
                  <span className="min-w-0 truncate text-fg">{change.path}</span>
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-bg-deep">
              {selected ? (
                diffLoading ? (
                  <div className="px-3 py-3 text-[12px] text-fg-muted">{t('正在读取差异…')}</div>
                ) : diff ? (
                  <DiffView text={diff} />
                ) : null
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-[12px] text-fg-dim">
                  <FileDiff size={24} strokeWidth={1.3} />
                  <span>{t('选择一个更改查看差异')}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    )
  } else {
    body = <div className="px-4 py-6 text-[13px] text-fg-muted">{t('正在读取 Git 状态…')}</div>
  }

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="px-4 h-9 flex items-center justify-between text-[11px] font-semibold tracking-wide text-fg-muted flex-shrink-0">
        <span className="flex items-center gap-2 min-w-0">
          <GitBranch size={13} className="flex-shrink-0" />
          <span className="truncate">{t('源代码管理')}</span>
        </span>
        <Tooltip label={t('刷新')} side="bottom">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || !currentProject}
            aria-label={t('刷新')}
            className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-accent' : undefined} />
          </button>
        </Tooltip>
      </div>
      {body}
    </div>
  )
}
