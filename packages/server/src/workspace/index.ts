import { agentHandlers } from './agents/index'
import { fsHandlers } from './fs/index'
import { gitHandlers } from './git/index'
import type { WorkspaceHandler } from './registry'

export { WorkspaceError } from './registry'
export type { WorkspaceContext, WorkspaceHandler, WorkspaceHandlers } from './registry'

const handlers = new Map<string, WorkspaceHandler>(
  Object.entries({ ...fsHandlers, ...gitHandlers, ...agentHandlers }).filter(
    (entry): entry is [string, WorkspaceHandler] => typeof entry[1] === 'function',
  ),
)

export function findWorkspaceHandler(method: string): WorkspaceHandler | undefined {
  return handlers.get(method)
}
