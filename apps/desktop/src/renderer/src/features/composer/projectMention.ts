// 工作区和主对话位于不同的面板，按目标和项目传递一次性的引用请求。
import { isSamePath, toWorkspaceRoot } from '../explorer/treeModel'

type Receiver = (relative: string) => void
let active: { targetId: string; root: string; receive: Receiver } | null = null

export function receiveProjectMentions(targetId: string, root: string, receive: Receiver) {
  const receiver = { targetId, root, receive }
  active = receiver
  return () => {
    if (active === receiver) active = null
  }
}

export function addProjectMention(targetId: string, root: string, relative: string): boolean {
  if (!relative || active?.targetId !== targetId) return false
  const project = toWorkspaceRoot(root)
  if (active.root !== root &&
      (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(project) || !isSamePath(toWorkspaceRoot(active.root), project, 'windows'))) return false
  active.receive(relative)
  return true
}
