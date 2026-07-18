import { ChevronRight } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import { isDescendantOf, normalizePath, parentPath, pathsEqual } from '../utils/fileReferences'

function projectRelativePath(projectPath: string, filePath: string) {
  const root = normalizePath(projectPath)
  const file = normalizePath(filePath)
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return file.slice(root.length + 1)
  }
  return file.split('/').pop() || file
}

/** Absolute path for the first `segmentCount` relative segments, keeping the file's path separators. */
function pathAtRelativeDepth(filePath: string, segmentCount: number, totalSegments: number) {
  if (segmentCount >= totalSegments) return filePath
  let path = filePath
  for (let i = 0; i < totalSegments - segmentCount; i++) {
    path = parentPath(path)
  }
  return path
}

export default function EditorBreadcrumbs() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const tabs = useEditorStore(s => s.tabs)
  const setView = useUIStore(s => s.setView)

  const activeTab = tabs.find(tab => tab.id === activeTabId)
  if (!activeTab || !currentProject || activeTab.kind === 'diff') return null

  const fileInProject =
    isDescendantOf(activeTab.path, currentProject.path) &&
    !pathsEqual(activeTab.path, currentProject.path)

  const relative = fileInProject
    ? projectRelativePath(currentProject.path, activeTab.path)
    : normalizePath(activeTab.path).split('/').pop() || activeTab.path
  const segments = relative.split('/').filter(Boolean)
  if (segments.length === 0) return null

  const revealInExplorer = (path: string) => {
    // Open explorer (and the sidebar) first; defer reveal so Sidebar is mounted
    // and its expand/scroll effects observe the new treeRevealSeq.
    setView('explorer')
    window.requestAnimationFrame(() => {
      void useProjectStore.getState().revealFileInTree(path)
    })
  }

  return (
    <div className="ui-font-scaled flex h-[22px] flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-bg-deep px-3 text-[11px] text-fg-muted select-none">
      <button
        type="button"
        className="max-w-[140px] cursor-pointer truncate rounded px-1.5 bg-bg-hover/80 text-fg hover:bg-bg-active"
        title={currentProject.path}
        aria-label={t('在资源管理器中定位')}
        onClick={() => revealInExplorer(currentProject.path)}
      >
        {currentProject.name}
      </button>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1
        const targetPath = fileInProject
          ? pathAtRelativeDepth(activeTab.path, index + 1, segments.length)
          : activeTab.path
        const clickable = fileInProject || isLast

        return (
          <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight size={12} className="flex-shrink-0 opacity-60" aria-hidden />
            <button
              type="button"
              disabled={!clickable}
              className={`max-w-[180px] truncate rounded px-1 transition-colors ${
                clickable
                  ? 'cursor-pointer hover:bg-bg-hover hover:text-fg'
                  : 'cursor-default'
              } ${isLast ? 'text-fg' : ''}`}
              title={targetPath}
              aria-label={t('在资源管理器中定位')}
              onClick={() => {
                if (!clickable) return
                revealInExplorer(targetPath)
              }}
            >
              {segment}
            </button>
          </span>
        )
      })}
    </div>
  )
}
