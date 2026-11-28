import { t, translateMessage } from '@qn/codex-client'
import { ChevronRight, Plus, type LucideIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { agentLabel, sessionKey } from '../agents'
import { defaultAgentFor, targetAgents, useApp } from '../store'
import type { AgentKind, Project } from '../types'
import { workspaceProject } from '../workspace'
import { Button, Dialog, Loading, Note } from './ui'

export function NewSessionButton({ project, projects, iconOnly, icon: Icon = Plus, primary, className, onCreated }: {
  project?: Project
  projects?: readonly Project[]
  iconOnly?: boolean
  /** 图标按钮可换成更贴合场景的图形，如对话页顶栏用气泡加号。 */
  icon?: LucideIcon
  primary?: boolean
  className?: string
  onCreated?: () => void
}) {
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Project>()
  const activeId = useApp((s) => s.activeId)
  const connected = useApp((s) => s.eventsConnected)
  const selected = project ?? chosen
  const label = project ? t('在 {name} 新建会话', { name: project.name }) : t('新建会话')

  return (
    <>
      <Button variant={primary ? 'primary' : 'ghost'} className={className} disabled={!activeId || !connected || (!project && !projects?.length)}
        aria-label={label} title={label} aria-haspopup="dialog" onClick={() => {
          setChosen(projects?.length === 1 ? projects[0] : undefined)
          setOpenFor(activeId)
          void useApp.getState().loadAgentSettings()
        }}>
        <Icon size={iconOnly ? 19 : 17} strokeWidth={1.75} aria-hidden />{!iconOnly && t('新建会话')}
      </Button>
      {openFor && openFor === activeId && (selected ? (
        <AgentPicker key={selected.id} project={selected} onClose={() => setOpenFor(null)}
          onBack={!project && (projects?.length ?? 0) > 1 ? () => setChosen(undefined) : undefined}
          onCreated={() => { setOpenFor(null); onCreated?.() }} />
      ) : (
        <Dialog title={t('选择会话项目')} onClose={() => setOpenFor(null)}>
          <ProjectChoices projects={projects ?? []} onPick={setChosen} />
        </Dialog>
      ))}
    </>
  )
}

function ProjectChoices({ projects, onPick }: { projects: readonly Project[]; onPick: (project: Project) => void }) {
  const targets = useApp((s) => s.targets)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = projects.filter((project) => [project.name, project.path, targets.find((target) => target.id === project.targetId)?.name]
    .some((text) => text?.toLowerCase().includes(needle)))
  return (
    <>
      <input type="search" className="qn-input mb-2" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={t('搜索项目')} aria-label={t('搜索项目')} />
      <div className="qn-list-group">
        {shown.map((project) => (
          <button key={project.id} type="button" className="qn-row qn-list-row w-full text-left" onClick={() => onPick(project)}>
            <span className="qn-row-copy">
              <span className="qn-list-primary qn-clamp-2">{project.name}</span>
              <span className="qn-subtitle block">{[targets.find((target) => target.id === project.targetId)?.name, project.path].filter(Boolean).join(' · ')}</span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-qn-dim" aria-hidden />
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="py-3 text-sm text-qn-muted">{t('没有匹配的项目。')}</p>}
    </>
  )
}

function AgentPicker({ project, onClose, onBack, onCreated }: {
  project: Project
  onClose: () => void
  onBack?: () => void
  onCreated: () => void
}) {
  const targetId = project.targetId
  const settings = useApp((s) => s.agentSettings)
  const sessions = useApp((s) => s.sessions)
  const connected = useApp((s) => s.eventsConnected)
  const connectionWarning = useApp((s) => s.eventsError)
  const target = useApp((s) => s.targets.find((item) => item.id === targetId))
  const targetState = useApp((s) => s.targetStates[targetId]?.state)
  const targetError = useApp((s) => s.targetErrors[targetId])
  const requestConnect = useApp((s) => s.requestConnect)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const creatingRef = useRef(false)
  const agents = targetAgents({ agentSettings: settings }, targetId)
  const preferred = defaultAgentFor({ agentSettings: settings, sessions }, targetId)
  const connecting = targetState === 'connecting' || targetState === 'deploying'
  const needsTarget = targetState === 'idle' || targetState === 'error'

  async function create(agent: AgentKind) {
    const app = useApp.getState()
    if (creatingRef.current || !app.activeId) return
    creatingRef.current = true
    setCreating(true)
    setError(undefined)
    try {
      if (await app.newThread(agent, workspaceProject(project, app.activeId))) onCreated()
      else setError(useApp.getState().error ?? t('无法新建会话，请重试。'))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  return (
    <Dialog title={t('新建会话')} onClose={() => { if (!creatingRef.current) onClose() }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm text-qn-muted">{[target?.name, project.name].filter(Boolean).join(' · ')}</p>
        {onBack && <Button variant="ghost" className="shrink-0" disabled={creating} onClick={onBack}>{t('更换项目')}</Button>}
      </div>
      {!connected && connectionWarning && <Note message={connectionWarning} tone="warn" />}
      {connected && connecting && <Loading text={t('正在连接项目目标…')} />}
      {targetError && needsTarget && <Note message={targetError} tone="error" />}
      {error && <Note message={error} tone="error" />}
      {connected && target && !connecting && (needsTarget || (error && targetState !== 'ready')) && (
        <Button className="my-2 w-full" onClick={() => { setError(undefined); requestConnect(targetId) }}>{t('连接目标')}</Button>
      )}
      {creating && <Loading text={t('正在新建会话…')} />}
      {agents.length === 0 && <Note message={t('请在电脑端为这个目标启用至少一个 Agent。')} />}
      <div className="qn-list-group">
        {agents.map((agent) => {
          const reason = sessions[sessionKey(targetId, agent)]?.openError
          return (
            <button key={agent} type="button" className="qn-row qn-list-row w-full text-left"
              disabled={!connected || connecting || needsTarget || creating} onClick={() => void create(agent)}>
              <span className="qn-row-copy">
                <span className="qn-list-primary">{agentLabel(agent)} {agent === preferred && <span className="text-xs text-qn-muted">{t('默认')}</span>}</span>
                {reason && <span className="qn-subtitle block">{translateMessage(reason)}</span>}
                {agent === 'pi' && !reason && <span className="qn-subtitle block">{t('工具直接执行')}</span>}
              </span>
              <ChevronRight size={16} className="shrink-0 text-qn-dim" aria-hidden />
            </button>
          )
        })}
      </div>
    </Dialog>
  )
}
