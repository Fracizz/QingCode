import { useState } from 'react'
import { useApp } from '../store'
import { filterProjects } from '../workspace'
import { Button, Empty, Header, Loading, Note } from './ui'
import { WorkspaceProjectRow, WorkspaceSearch } from './WorkspaceHome'

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
  const [query, setQuery] = useState('')

  const target = targets.find((item) => item.id === selectedTargetId)
  const list = filterProjects(projects.filter((item) => item.targetId === selectedTargetId), targets, query)

  return (
    <>
      <Header title="项目" subtitle={target?.name} onBack={goBack} />
      <main className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {projects.length > 0 && <WorkspaceSearch label="按项目、主机或路径搜索" query={query} onChange={setQuery} />}
        {loading && <Loading text="正在读取项目…" />}
        {!loading && list.length === 0 && <Empty>{query ? '没有匹配的项目。' : '该目标下还没有项目。'}</Empty>}
        {list.length > 0 && (
          <div className="qn-list-group mt-3">
            {list.map((project) => <WorkspaceProjectRow key={project.id} project={project} target={target}
              onOpen={() => void selectProject(project.id)} />)}
          </div>
        )}
      </main>
      <div className="qn-footer">
        <Button variant="primary" className="w-full" onClick={() => void openDirectory()}>＋ 添加项目</Button>
      </div>
    </>
  )
}
