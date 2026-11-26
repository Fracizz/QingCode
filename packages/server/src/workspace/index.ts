import { agentHandlers } from './agents/index'
import { fsHandlers } from './fs/index'
import { gitHandlers } from './git/index'
import { runHandlers } from './run/index'
import { terminalHandlers } from '../terminal/index'
import type { WorkspaceHandler } from './registry'

export { WorkspaceError } from './registry'
export type { WorkspaceContext, WorkspaceHandler, WorkspaceHandlers } from './registry'
export { activeRunCount } from './run/index'

const handlers = new Map<string, WorkspaceHandler>(
  Object.entries({ ...fsHandlers, ...gitHandlers, ...agentHandlers, ...runHandlers, ...terminalHandlers }).filter(
    (entry): entry is [string, WorkspaceHandler] => typeof entry[1] === 'function',
  ),
)

export function findWorkspaceHandler(method: string): WorkspaceHandler | undefined {
  return handlers.get(method)
}
