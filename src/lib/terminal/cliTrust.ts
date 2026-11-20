import { safeInvoke } from '../tauri'

/** 预热支持的 CLI；只有 Claude Code 与 Codex 有目录信任记录，OpenCode 不需要。 */
export type PrewarmCliAgent = 'claude' | 'codex' | 'opencode'

export function prewarmCliAgent(command: string): PrewarmCliAgent | undefined {
  const agent = command.trim()
  return agent === 'claude' || agent === 'codex' || agent === 'opencode' ? agent : undefined
}

export function cliHasDirectoryTrust(agent: PrewarmCliAgent | undefined): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex'
}

export function cliDisplayName(agent: PrewarmCliAgent) {
  return agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'OpenCode'
}

export interface CliTrustResult {
  configFound: boolean
  /** 被该 CLI 信任的、QingCode 已注册且已信任的项目根 URI。 */
  roots: string[]
  error?: string
}

const OK_TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000
const cache = new Map<string, { value: CliTrustResult; at: number }>()
const pending = new Map<string, Promise<CliTrustResult>>()

/** 候选项目变化（新信任/撤销）时换 key，避免沿用旧的匹配结果。 */
function cacheKey(connectionId: string, agent: string, candidates: readonly string[]) {
  return `${connectionId}\n${agent}\n${[...candidates].sort().join('\n')}`
}

export function cachedCliTrust(connectionId: string, agent: 'claude' | 'codex', candidates: readonly string[]) {
  const hit = cache.get(cacheKey(connectionId, agent, candidates))
  if (!hit) return
  const ttl = hit.value.error ? ERROR_TTL_MS : OK_TTL_MS
  return Date.now() - hit.at < ttl ? hit.value : undefined
}

/**
 * 只读读取远端 CLI 自己的信任配置（用户为该连接显式开启后才调用）。
 * 失败不抛出，结果里带 error，短时缓存以免每次聚焦都重复执行远端命令。
 */
export function loadCliTrust(connectionId: string, agent: 'claude' | 'codex', candidates: readonly string[], force = false): Promise<CliTrustResult> {
  const key = cacheKey(connectionId, agent, candidates)
  if (!force) {
    const hit = cachedCliTrust(connectionId, agent, candidates)
    if (hit) return Promise.resolve(hit)
  }
  const running = pending.get(key)
  if (running) return running
  const request = safeInvoke<CliTrustResult>('读取 CLI 信任配置', 'ssh_cli_trusted_roots', { connectionId, agent })
    .then(value => ({ configFound: value.configFound, roots: value.roots }),
      (error: unknown) => ({ configFound: false, roots: [], error: error instanceof Error ? error.message : String(error) }))
    .then(value => {
      cache.set(key, { value, at: Date.now() })
      pending.delete(key)
      return value
    })
  pending.set(key, request)
  return request
}

export function clearCliTrustCache() {
  cache.clear()
}
