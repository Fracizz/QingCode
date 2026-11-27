import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useApp } from '../store'
import { filterProjects, orderWorkspaceProjects, placeWorkspaceProject, useWorkspacePreferences } from '../workspace'
import { SortableList } from './SortableList'
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
  const preferences = useWorkspacePreferences()
  const desktopId = useApp((s) => s.activeId)
  // 搜索结果只是子集，拖动后会丢掉未显示项目的相对顺序。
  const sorting = !query.trim() && desktopId !== null

  const target = targets.find((item) => item.id === selectedTargetId)
  const list = selectedTargetId ? orderWorkspaceProjects(filterProjects(projects, targets, query, selectedTargetId),
    preferences?.projectOrders[selectedTargetId]) : []

  return (
    <>
      <Header title="项目" subtitle={target?.name} onBack={goBack} />
      <main className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {projects.length > 0 && <WorkspaceSearch label="按项目、主机或路径搜索" query={query} onChange={setQuery} />}
        {loading && <Loading text="正在读取项目…" />}
        {!loading && list.length === 0 && <Empty>{query ? '没有匹配的项目。' : '该目标下还没有项目。'}</Empty>}
        {list.length > 0 && (
          <div className="mt-3">
            <SortableList items={list} itemKey={(project) => project.id} disabled={sorting === false} label="项目"
              onMove={(from, to) => desktopId && placeWorkspaceProject(desktopId, list, from, to)}>
              {(project) => <WorkspaceProjectRow project={project} target={target} sortable={sorting && list.length > 1}
                onOpen={() => void selectProject(project.id)} />}
            </SortableList>
          </div>
        )}
      </main>
      <div className="qn-footer">
        <Button variant="primary" className="w-full" onClick={() => void openDirectory()}><Plus size={17} aria-hidden />添加项目</Button>
      </div>
    </>
  )
}
