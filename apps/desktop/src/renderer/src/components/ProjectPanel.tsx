import { useEffect, useState } from 'react'
import { Folder, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { AGENTS, agentLabel } from '../lib/agents'
import { formatTime, threadKey } from '../lib/threads'
import { useCodex } from '../store/codex'
import { useProjects } from '../store/projects'
import { AgentIcon } from './AgentIcon'
import { DirectoryPicker } from './DirectoryPicker'
import { NewThreadDialog } from './NewThreadDialog'
import { Badge, EmptyState, ErrorNote, IconButton, Spinner } from './ui'

export function ProjectPanel({ targetId, targetName }: { targetId: string; targetName: string }) {
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const loading = useProjects((s) => s.loading)
  const projectError = useProjects((s) => s.error)
  const load = useProjects((s) => s.load)
  const select = useProjects((s) => s.select)
  const remove = useProjects((s) => s.remove)
  const add = useProjects((s) => s.add)

  const threads = useCodex((s) => s.threads)
  const threadsLoading = useCodex((s) => s.threadsLoading)
  const threadsError = useCodex((s) => s.threadsError)
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentAgent = useCodex((s) => s.currentAgent)
  const agentStatuses = useCodex((s) => s.agents[targetId])
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const openThread = useCodex((s) => s.openThread)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [contextId, setContextId] = useState<string | null>(null)
  const [newThreadOpen, setNewThreadOpen] = useState(false)

  useEffect(() => {
    void load(targetId)
  }, [targetId, load])

  const selectedProject = projects.find((project) => project.id === selectedId)
  const unavailable = AGENTS.filter((agent) => agentStatuses?.[agent]?.state === 'unavailable')

  return (
    <section
      className="flex w-72 shrink-0 flex-col border-r border-qn-border bg-qn-panel"
      onClick={() => setContextId(null)}
    >
      <div className="flex items-center justify-between border-b border-qn-border px-3 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">项目</div>
          <div className="truncate text-[11px] text-qn-muted">{targetName}</div>
        </div>
        <button className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-[11px]"
          onClick={() => setPickerOpen(true)}>
          <Plus size={12} /> 添加项目
        </button>
      </div>

      <div className="min-h-0 flex-[2] overflow-y-auto px-2 py-2">
        {loading && <div className="px-2 py-2"><Spinner label="加载项目…" /></div>}
        {!loading && projects.length === 0 && (
          <EmptyState>暂无项目。点击「添加项目」浏览目录或手动输入路径。</EmptyState>
        )}
        {projects.map((project) => (
          <div
            key={project.id}
            className={`group relative mb-0.5 flex items-center gap-1 rounded px-2 py-2 text-xs ${
              project.id === selectedId ? 'bg-qn-accent/15' : 'hover:bg-white/5'
            }`}
            onContextMenu={(event) => {
              event.preventDefault()
              setContextId(project.id)
            }}
          >
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => void select(project)}>
              <Folder size={14} className="shrink-0 text-amber-300" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.name}</span>
                <span className="block truncate font-mono text-[10px] text-qn-muted">{project.path}</span>
              </span>
            </button>
            <span className="shrink-0 text-[10px] text-qn-muted">
              {formatTime(project.lastOpenedAt)}
            </span>
            <IconButton
              label="删除项目"
              danger
              className="opacity-0 group-hover:opacity-100"
              onClick={() => void remove(project.id)}
            >
              <Trash2 size={13} />
            </IconButton>
            {contextId === project.id && (
              <div className="absolute right-2 top-9 z-10 w-36 rounded border border-qn-border bg-[#252525] py-1 text-xs shadow-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-qn-danger hover:bg-white/10"
                  onClick={() => {
                    setContextId(null)
                    void remove(project.id)
                  }}
                >
                  <Trash2 size={13} /> 删除项目
                </button>
              </div>
            )}
          </div>
        ))}
        <div className="mt-2 px-1">
          <ErrorNote message={projectError} onRetry={() => void load(targetId)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-[3] flex-col border-t border-qn-border">
        <div className="flex items-center justify-between border-b border-qn-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-medium">会话</span>
            {selectedProject && <Badge tone="accent">{selectedProject.name}</Badge>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="刷新会话列表" onClick={() => void refreshThreads()}>
              <RefreshCw size={13} />
            </IconButton>
            <button className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-[11px]"
              onClick={() => setNewThreadOpen(true)}>
              <Plus size={12} /> 新建会话
            </button>
          </div>
        </div>

        {unavailable.length > 0 && (
          <div className="border-b border-qn-border px-3 py-1.5 text-[11px] text-qn-muted">
            {unavailable.map((agent) => agentLabel(agent)).join(' / ')} 不可用，仅显示可用 Agent 的会话
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {threadsLoading && <div className="px-2 py-2"><Spinner label="加载会话…" /></div>}
          {!threadsLoading && threads.length === 0 && (
            <EmptyState>
              {selectedProject
                ? '该目录下暂无会话，新建一个开始对话。'
                : '选择项目后显示该目录下的会话；也可直接新建会话。'}
            </EmptyState>
          )}
          {threads.map((thread) => (
            <button
              key={threadKey(thread.agent, thread.id)}
              className={`mb-0.5 block w-full rounded px-2 py-2 text-left text-xs ${
                thread.id === currentThreadId && thread.agent === currentAgent
                  ? 'bg-qn-accent/20'
                  : 'hover:bg-white/5'
              }`}
              onClick={() => void openThread(thread.id, thread.agent)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <AgentIcon agent={thread.agent} />
                  <span className="truncate font-medium">{thread.title}</span>
                </span>
                <span className="shrink-0 text-[10px] text-qn-muted">
                  {formatTime(thread.updatedAt)}
                </span>
              </div>
              {thread.preview && (
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-qn-muted">
                  {thread.preview}
                </div>
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-qn-border px-2 py-2">
          <ErrorNote message={threadsError} onRetry={() => void refreshThreads()} />
        </div>
      </div>

      {pickerOpen && (
        <DirectoryPicker
          targetId={targetId}
          onClose={() => setPickerOpen(false)}
          onConfirm={(path) => {
            setPickerOpen(false)
            void add(targetId, path)
          }}
        />
      )}
      {newThreadOpen && <NewThreadDialog onClose={() => setNewThreadOpen(false)} />}
    </section>
  )
}
