// Only successful new desktop tabs enter this window-local history. Closing a tab keeps its sample.
type ShellOpen = { projectId: string; outcome: 'hit' | 'miss'; ms: number; reason?: string }
const recent: ShellOpen[] = []
const limit = 100

export function recordShellOpen(projectId: string, outcome: ShellOpen['outcome'], ms: number, reason?: string) {
  recent.push({ projectId, outcome, ms: Math.round(ms), reason })
  if (recent.length > limit) recent.shift()
}

function latency(samples: number[]) {
  samples.sort((a, b) => a - b)
  const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1] ?? null
  return { count: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }
}

/** 一组项目（如同一主机下的项目）最近新建终端的命中、未命中次数及未命中原因。 */
export function recentShellOpenCounts(projectIds: ReadonlySet<string>) {
  let hit = 0
  let miss = 0
  const missReasons: Record<string, number> = {}
  for (const sample of recent) {
    if (!projectIds.has(sample.projectId)) continue
    if (sample.outcome === 'hit') {
      hit++
    } else {
      miss++
      const reason = sample.reason ?? 'unknown'
      missReasons[reason] = (missReasons[reason] ?? 0) + 1
    }
  }
  return { hit, miss, missReasons }
}

export function recentShellOpens(projectId: string) {
  const hit: number[] = []
  const miss: number[] = []
  const missReasons: Record<string, number> = {}
  for (const sample of recent) {
    if (sample.projectId !== projectId) continue
    if (sample.outcome === 'hit') {
      hit.push(sample.ms)
    } else {
      miss.push(sample.ms)
      const reason = sample.reason ?? 'unknown'
      missReasons[reason] = (missReasons[reason] ?? 0) + 1
    }
  }
  return { hit: latency(hit), miss: latency(miss), missReasons }
}
