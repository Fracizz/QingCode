import type { RunConfig } from './runConfigModel'
import type { RunInfo } from './types'

// 面板展示用的纯函数：输出标签、配置运行状态、状态文字。

export function isRunning(run: RunInfo): boolean {
  return run.endedAt === undefined
}

/** 每个关联键只显示最近一次运行；无键的临时运行各占一个标签。已结束且被用户关闭的不显示。 */
export function runTabs(runs: RunInfo[], hidden: Record<string, true>): RunInfo[] {
  const latest = new Map<string, RunInfo>()
  for (const run of runs) {
    const key = run.key ?? `run:${run.runId}`
    const prev = latest.get(key)
    if (!prev || run.startedAt >= prev.startedAt) latest.set(key, run)
  }
  return [...latest.values()]
    .filter((run) => isRunning(run) || !hidden[run.runId])
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function runsForConfig(config: RunConfig, runs: RunInfo[]): RunInfo[] {
  const prefix = `${config.id}/`
  return runs.filter((run) => run.key?.startsWith(prefix))
}

export type ConfigStatus = 'running' | 'failed' | 'ok' | 'idle'

/** 运行中优先；否则看每个任务最近一次运行，有非零退出即失败。 */
export function configStatus(config: RunConfig, runs: RunInfo[], stopped: Record<string, true> = {}): ConfigStatus {
  const related = runsForConfig(config, runs)
  if (related.length === 0) return 'idle'
  if (related.some(isRunning)) return 'running'
  const latest = new Map<string, RunInfo>()
  for (const run of related) {
    const prev = latest.get(run.key!)
    if (!prev || run.startedAt >= prev.startedAt) latest.set(run.key!, run)
  }
  // 用户主动停止的不算失败（Windows taskkill /F 的退出码是 1）。
  return [...latest.values()].some((run) => run.exitCode !== 0 && !stopped[run.runId]) ? 'failed' : 'ok'
}

export function runStatusText(run: RunInfo, stopped = false): string {
  if (isRunning(run)) return run.pid ? `运行中 · PID ${run.pid}` : '运行中'
  if (stopped) return '已停止'
  if (run.exitCode === null || run.exitCode === undefined) return run.signal ? `已终止（${run.signal}）` : '已终止'
  return `已退出（${run.exitCode}）`
}
