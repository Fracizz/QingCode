import { formatTime } from '../state'
import { useApp } from '../store'
import { Button, Card, Empty, Header, Loading, Note } from './ui'

export function ProjectsPage() {
  const targets = useApp((s) => s.targets)
  const selectedTargetId = useApp((s) => s.selectedTargetId)
  const projects = useApp((s) => s.projects)
  const loading = useApp((s) => s.projectsLoading)
  const error = useApp((s) => s.error)
  const clearError = useApp((s) => s.clearError)
  const goBack = useApp((s) => s.goBack)
  const selectProject = useApp((s) => s.selectProject)
  const openDirectory = useApp((s) => s.openDirectory)

  const target = targets.find((item) => item.id === selectedTargetId)
  const list = projects.filter((item) => item.targetId === selectedTargetId)

  return (
    <>
      <Header title="项目" subtitle={target?.name ?? ''} onBack={goBack} />
      <div className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {loading && <Loading text="正在读取项目…" />}
        {!loading && list.length === 0 && (
          <Empty>该目标下还没有项目。点下方「添加项目」浏览电脑目录。</Empty>
        )}
        <div className="space-y-3">
          {list.map((project) => (
            <Card key={project.id}>
              <button type="button" className="qn-row" onClick={() => void selectProject(project.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span className="qn-subtitle qn-mono block">{project.path}</span>
                  <span className="qn-subtitle block">最近打开：{formatTime(project.lastOpenedAt)}</span>
                </span>
                <span className="text-qn-muted">›</span>
              </button>
            </Card>
          ))}
        </div>
      </div>
      <div className="qn-footer">
        <Button variant="primary" className="w-full" onClick={() => void openDirectory()}>
          ＋ 添加项目
        </Button>
      </div>
    </>
  )
}
