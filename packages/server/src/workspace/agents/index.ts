import type { WorkspaceHandlers } from '../registry'
import { agentProbe } from './probe'

export const agentHandlers: WorkspaceHandlers = {
  'agent.probe': agentProbe,
}
