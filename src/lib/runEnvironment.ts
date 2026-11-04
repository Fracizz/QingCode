import { isSshResource, safeInvoke } from './tauri'
import { RUN_OS, type RunOs } from './runTaskPlatform'

export interface RunEnvironment {
  os: RunOs
  kind: 'local' | 'wsl' | 'ssh'
  distro?: string
}

export async function getRunEnvironment(path: string): Promise<RunEnvironment> {
  const result = await safeInvoke<RunEnvironment>(
    '识别运行环境',
    isSshResource(path) ? 'ssh_run_environment' : 'resolve_run_environment',
    { path }
  )
  if (!result || !RUN_OS.includes(result.os)) throw new Error('无法识别项目执行系统')
  return result
}
