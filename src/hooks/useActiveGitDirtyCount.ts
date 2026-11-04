import { useProjectStore } from '../store/projectStore'
import { useGitStatusStore } from '../store/gitStatusStore'

/** All Git badges read the same last successful snapshot for their project. */
export function useActiveGitDirtyCount(): number {
  const currentProjectPath = useProjectStore(s => s.currentProject?.path ?? null)
  return useGitStatusStore(s => s.dirtyCountFor(currentProjectPath))
}
