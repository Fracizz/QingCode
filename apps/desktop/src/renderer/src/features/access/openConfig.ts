import type { ServerParams } from '@qn/protocol'
import type { AgentKind } from '../../../../shared/backendApi'

export function configuredAgentOpen(
  agent: AgentKind,
  preferences: { path?: string | null; configDir?: string | null },
): ServerParams<'codex.open'> {
  const path = preferences.path?.trim() || undefined
  const directory = preferences.configDir?.trim() || undefined
  if (agent === 'codex') return {
    agent,
    ...(path ? { codexPath: path } : {}),
    ...(directory ? { codexHome: directory } : {}),
  }
  if (agent === 'claude') return {
    agent,
    ...(path ? { claudePath: path } : {}),
    ...(directory ? { claudeConfigDir: directory } : {}),
  }
  return { agent, ...(path ? { piPath: path } : {}) }
}
