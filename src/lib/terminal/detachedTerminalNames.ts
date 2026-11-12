import type { TerminalTab } from '../../types'
import { loadNamedWorkspaceCatalog } from '../namedWorkspacePersist'
import { loadWorkspaceSession, type PersistedTerminalMeta } from '../workspaceSessionPersist'
import type { SshDetachedTerminal } from './terminalRestorePlan'

type Identity = Pick<SshDetachedTerminal, 'connectionId' | 'ptyId' | 'originalTabId'>

const PREFIX = 'qingcode:preserved-terminal-name:'
const nameKey = (connectionId: string, ptyId: string) => PREFIX + JSON.stringify([connectionId, ptyId])

/** “保留并退出”也适用于不随项目保存的运行任务。每个 PTY 独立写入，多个窗口不会互相覆盖。 */
export function rememberPreservedTerminalName(tab: TerminalTab) {
  if (!tab.ptyId || !tab.cwd.startsWith('ssh://') || !tab.name.trim()) return
  const connectionId = tab.connectionId ?? tab.cwd.slice('ssh://'.length).split('/')[0]
  try {
    localStorage.setItem(nameKey(connectionId, tab.ptyId), JSON.stringify({ name: tab.name, savedAt: Date.now() }))
  } catch { /* Storage can be unavailable during shutdown. */ }
}

function preservedName(terminal: Identity): string | undefined {
  try {
    const raw = localStorage.getItem(nameKey(terminal.connectionId, terminal.ptyId))
    if (!raw) return
    const entry = JSON.parse(raw)
    if (typeof entry?.name === 'string' && entry.name !== terminal.originalTabId) return entry.name
  } catch { /* Ignore a missing or damaged local record. */ }
}

/** 清理已经接回的记录，以及远端已自行回收、一直没能接回的旧记录。 */
export function forgetPreservedTerminalName(connectionId: string, ptyId: string) {
  try { localStorage.removeItem(nameKey(connectionId, ptyId)) } catch { /* private mode */ }
}

export function prunePreservedTerminalNames() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      try {
        if (JSON.parse(localStorage.getItem(key) ?? 'null')?.savedAt >= cutoff) continue
      } catch { /* Drop malformed records too. */ }
      localStorage.removeItem(key)
    }
  } catch { /* private mode */ }
}

type NameRecord = Pick<PersistedTerminalMeta, 'id' | 'ptyId' | 'connectionId' | 'cwd' | 'name'>

function namedWorkspaceTabs(projectId: string) {
  return loadNamedWorkspaceCatalog().workspaces.sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap(workspace => workspace.sessions[projectId]?.terminals ?? [])
}

function recordedName(terminal: Identity, records: readonly NameRecord[]) {
  return records.find(tab =>
    tab.cwd.startsWith(`ssh://${terminal.connectionId}/`) && (!tab.connectionId || tab.connectionId === terminal.connectionId)
    && (tab.ptyId ? tab.ptyId === terminal.ptyId : tab.id === terminal.originalTabId)
    && tab.name.trim() && tab.name !== terminal.originalTabId,
  )?.name
}

/** 本地标签及快照可用 PTY ID 匹配；没有 PTY ID 的旧快照只接受原标签 UUID。 */
export function terminalNameForReattach(projectId: string, openTabs: readonly TerminalTab[]) {
  let automatic: NameRecord[] | undefined
  let named: NameRecord[] | undefined
  const live = openTabs.filter(tab => tab.projectId === projectId)
  return (terminal: Identity & { name?: string }): string | undefined => {
    const current = preservedName(terminal) ?? recordedName(terminal, live)
    if (current) return current
    automatic ??= loadWorkspaceSession()?.projects[projectId]?.terminals ?? []
    const saved = recordedName(terminal, automatic)
    if (saved || terminal.name) return saved ?? terminal.name
    named ??= namedWorkspaceTabs(projectId)
    return recordedName(terminal, named)
  }
}

/** 老版本已经接回且把 UUID 存进工作区的标签。只有能对上原始标签记录才修正。 */
export function recoverMisnamedTab(tab: TerminalTab): string | undefined {
  if (!tab.persistent || !tab.ptyId || !tab.cwd.startsWith('ssh://') || tab.profileId || tab.shellKind || tab.launchCommand) return
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tab.name)) return
  const connectionId = tab.connectionId ?? tab.cwd.slice('ssh://'.length).split('/')[0]
  const identity = { connectionId, ptyId: tab.ptyId, originalTabId: tab.name }
  const records = [...(loadWorkspaceSession()?.projects[tab.projectId]?.terminals ?? []), ...namedWorkspaceTabs(tab.projectId)]
  return recordedName(identity, records.filter(record => record.id === tab.name))
}
