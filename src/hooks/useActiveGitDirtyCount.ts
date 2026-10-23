import { useProjectStore } from '../store/projectStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { gitDirtyCountForProject } from '../lib/projectIndicators'

/**
 * 当前项目的 Git 更改数（活动栏 / 状态栏共用）。
 *
 * 状态库里还留着上一个项目的快照时返回 0，而不是把那个数字显示到当前项目上。
 */
export function useActiveGitDirtyCount(): number {
  const currentProjectPath = useProjectStore(s => s.currentProject?.path ?? null)
  const storeProjectPath = useGitStatusStore(s => s.projectPath)
  const storeDirtyCount = useGitStatusStore(s => s.dirtyCount)
  return gitDirtyCountForProject(currentProjectPath, storeProjectPath, storeDirtyCount)
}
