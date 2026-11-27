import { Check, ChevronDown, Folder, FolderPlus, PlugZap, ServerCog } from 'lucide-react'
import { getLocale, t } from '@qn/codex-client'
import { isTargetActive, isTargetBusy, targetStateLabel } from '../../lib/targetStatus'
import { useProjects } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { useUi } from '../../store/ui'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../primitives'
import { targetDisplayName } from '../targetName'
import { Logo } from './Logo'

/**
 * 新会话草稿页（参考 Codex 的 "Let's build"）：大标题 + 项目切换，输入框在下方，直接打字即可开始。
 * 只有走不下去时才给一个主操作：目标未连接 → 连接；没有项目 → 添加项目。
 */
export function WelcomePane({ onConnect, onAddTarget }: { onConnect: (id: string) => void; onAddTarget: () => void }) {
  const targets = useTargets((s) => s.targets)
  const selectedId = useTargets((s) => s.selectedId)
  const state = useTargets((s) => s.states[s.selectedId]?.state ?? 'idle')
  const projects = useProjects((s) => s.projects)
  const projectId = useProjects((s) => s.selectedId)
  const selectProject = useProjects((s) => s.select)
  const openPicker = useUi((s) => s.openDirectoryPicker)

  const target = targets.find((item) => item.id === selectedId)
  const project = projects.find((item) => item.id === projectId)
  const active = isTargetActive(state)
  const targetName = target ? targetDisplayName(target) : t('本机')

  return (
    // flex-1 而不是 h-full：父级是 min-h-full 的弹性列，百分比高度解析不出来，内容会贴顶。
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6">
      <div className="relative">
        <div
          className="pointer-events-none absolute -inset-16 -z-10"
          style={{ background: 'radial-gradient(circle, rgba(78,205,181,0.12) 0%, rgba(78,205,181,0) 65%)' }}
        />
        <Logo size={40} />
      </div>
      <h1 className="mt-5 text-[28px] font-semibold tracking-tight text-qn-text">{t('开始构建')}</h1>

      {active && projects.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="mt-2 inline-flex h-9 max-w-md items-center gap-2 rounded-lg px-3 text-ui-lg text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover"
            >
              <Folder size={16} className="shrink-0" />
              <span className="truncate">{project?.name ?? t('选择项目')}</span>
              <ChevronDown size={15} className="shrink-0" />
            </button>
          </MenuTrigger>
          <MenuContent align="center" className="max-h-[min(420px,60vh)] w-72 overflow-y-auto">
            <MenuLabel>{t('{target} 上的项目', { target: targetName })}</MenuLabel>
            {projects.map((item) => (
              <MenuItem
                key={item.id}
                icon={<Folder size={14} />}
                hint={item.id === projectId ? <Check size={14} className="text-qn-text" /> : undefined}
                title={item.path}
                onSelect={() => void selectProject(item)}
              >
                {item.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<FolderPlus size={14} />} onSelect={() => openPicker()}>
              {t('添加项目…')}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}

      {project && active && <p className="mt-1 font-mono text-ui-sm text-qn-dim">{project.path}</p>}

      {!active && (
        <div className="mt-6 flex flex-col items-center gap-3">
          <p className="text-ui-md text-qn-muted">
            {targetName}
            <span className="mx-1.5 text-qn-dim">·</span>
            <span className={state === 'error' ? 'text-qn-danger' : ''}>{targetStateLabel[state]}</span>
          </p>
          <button
            type="button"
            className="qn-button inline-flex items-center gap-2 px-4 py-2"
            disabled={isTargetBusy(state)}
            onClick={() => onConnect(selectedId)}
          >
            <PlugZap size={16} />
            {isTargetBusy(state)
              ? t('正在连接…')
              // 不用占位模板：过短的模板会让 translateMessage 误匹配其他以“连接”开头的提示。
              : [t('连接'), targetName].join(getLocale() === 'en' ? ' ' : '')}
          </button>
        </div>
      )}

      {active && projects.length === 0 && (
        <div className="mt-6 flex flex-col items-center gap-3">
          <p className="text-ui-md text-qn-muted">{t('添加一个项目目录，会话会按项目归类；也可以不选项目直接开始。')}</p>
          <button type="button" className="qn-button inline-flex items-center gap-2 px-4 py-2" onClick={() => openPicker()}>
            <FolderPlus size={16} /> {t('添加项目')}
          </button>
        </div>
      )}

      <button
        type="button"
        className="mt-8 flex items-center gap-1.5 text-ui text-qn-dim hover:text-qn-text"
        onClick={onAddTarget}
      >
        <ServerCog size={14} /> {t('添加 SSH 连接，在远端主机上使用 Agent')}
      </button>
    </div>
  )
}
