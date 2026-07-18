import { ChevronRight } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { normalizePath } from '../utils/fileReferences'

function projectRelativePath(projectPath: string, filePath: string) {
  const root = normalizePath(projectPath)
  const file = normalizePath(filePath)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1)
  }
  return file.split('/').pop() || file
}

export default function EditorBreadcrumbs() {
  const currentProject = useProjectStore(s => s.currentProject)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const tabs = useEditorStore(s => s.tabs)
  const setView = useUIStore(s => s.setView)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)

  const activeTab = tabs.find(tab => tab.id === activeTabId)
  if (!activeTab || !currentProject || activeTab.kind === 'diff') return null

  const relative = projectRelativePath(currentProject.path, activeTab.path)
  const segments = relative.split('/').filter(Boolean)
  if (segments.length === 0) return null

  const revealToRelative = (segmentCount: number) => {
    setView('explorer')
    const partial = segments.slice(0, segmentCount).join('/')
    const absolute = `${normalizePath(currentProject.path)}/${partial}`
    void revealFileInTree(absolute)
  }

  return (
    <div className="ui-font-scaled flex h-[22px] flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-bg-deep px-3 text-[11px] text-fg-muted select-none">
      <button
        type="button"
        className="max-w-[140px] truncate rounded px-1 hover:bg-bg-hover hover:text-fg"
        onClick={() => setView('explorer')}
      >
        {currentProject.name}
      </button>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight size={12} className="flex-shrink-0 opacity-60" aria-hidden />
          <button
            type="button"
            className={`max-w-[180px] truncate rounded px-1 hover:bg-bg-hover hover:text-fg ${
              index === segments.length - 1 ? 'text-fg' : ''
            }`}
            onClick={() => revealToRelative(index + 1)}
          >
            {segment}
          </button>
        </span>
      ))}
    </div>
  )
}
