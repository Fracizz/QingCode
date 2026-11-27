import { useMemo } from 'react'
import { create } from 'zustand'
import type { FsChangedEvt } from '@qn/protocol'
import { t, translateMessage } from '@qn/codex-client'
import { BackendCallError, onBackendRestart } from '../../lib/backend'
import { friendlyError } from '../../lib/errors'
import { useTargets } from '../../store/targets'
import { isCwdUntrusted } from '../../store/projectTrust'
import { onServerEvt, serverCall } from '../workspace/serverCall'
import { appendOutput, clearOutput, emptyOutput, markDropped, type RunOutput } from './outputModel'
import { loadRunConfigs, saveRunConfigs, type LoadedRunConfigs } from './runConfigIo'
import { isConfigPath, normalizePath, runConfigPaths, samePath, type RunConfig } from './runConfigModel'
import type { RunDataEvt, RunExitEvt, RunInfo, RunOs, RunOutputChunk, RunStartParams } from './types'

// 运行状态（按目标）、输出（按 runId）与配置文件（按目标 + 项目根）。
// run.data / run.exit 在模块级订阅一次；连接重建后重新 run.list 以重新登记订阅并补齐输出。

export type TargetRuns = {
  platform: RunOs | null
  runs: Record<string, RunInfo>
  loading: boolean
  loaded: boolean
  error: string | null
}

export type ConfigScope = {
  targetId: string
  cwd: string
  loading: boolean
  data: LoadedRunConfigs | null
  error: string | null
  saving: boolean
}

type RunStore = {
  targets: Record<string, TargetRuns>
  outputs: Record<string, RunOutput>
  /** 用户关闭的已结束输出标签 */
  hidden: Record<string, true>
  /** 用户主动停止的 run（显示"已停止"而不是失败） */
  stopped: Record<string, true>
  scopes: Record<string, ConfigScope>
  /** 配置作用域变化时递增，供 fs.watch 合并登记 */
  watchRevision: number

  init: (targetId: string) => Promise<void>
  start: (targetId: string, params: RunStartParams) => Promise<string>
  stop: (targetId: string, runId: string) => Promise<void>
  clear: (runId: string) => void
  hide: (runId: string) => void
  loadConfigs: (targetId: string, cwd: string) => Promise<void>
  saveConfigs: (targetId: string, cwd: string, configs: RunConfig[]) => Promise<void>
}

const emptyTarget = (): TargetRuns => ({ platform: null, runs: {}, loading: false, loaded: false, error: null })

export const scopeKey = (targetId: string, cwd: string): string => `${targetId}\n${normalizePath(cwd)}`

function describeRunError(err: unknown, fallback: string): string {
  if (err instanceof BackendCallError && (err.code === 'method' || err.code === 'unknown_method')) {
    return t('{fallback}：目标上的 server 版本过旧，不支持运行配置，请重新连接以更新', { fallback })
  }
  return translateMessage(friendlyError(err, fallback))
}

const inits = new Map<string, Promise<void>>()
const fetching = new Set<string>()
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useRunStore = create<RunStore>((set, get) => {
  const patchTarget = (targetId: string, patch: Partial<TargetRuns>): void =>
    set((s) => ({ targets: { ...s.targets, [targetId]: { ...(s.targets[targetId] ?? emptyTarget()), ...patch } } }))

  const patchScope = (key: string, patch: Partial<ConfigScope>): void =>
    set((s) => {
      const prev = s.scopes[key]
      if (!prev) return {}
      return { scopes: { ...s.scopes, [key]: { ...prev, ...patch } } }
    })

  return {
    targets: {},
    outputs: {},
    hidden: {},
    stopped: {},
    scopes: {},
    watchRevision: 0,

    init: (targetId) => {
      const running = inits.get(targetId)
      if (running) return running
      const task = (async () => {
        patchTarget(targetId, { loading: true })
        try {
          const result = await serverCall(targetId, 'run.list', {})
          const runs: Record<string, RunInfo> = {}
          for (const run of result.runs) runs[run.runId] = run
          patchTarget(targetId, { platform: result.platform, runs, loading: false, loaded: true, error: null })
          await Promise.all(result.runs.map((run) => fetchOutput(targetId, run.runId)))
        } catch (err) {
          patchTarget(targetId, { loading: false, loaded: true, error: describeRunError(err, t('读取运行状态失败')) })
        }
      })().finally(() => inits.delete(targetId))
      inits.set(targetId, task)
      return task
    },

    start: async (targetId, params) => {
      // 命令面板等入口也会走这里，统一拦截未信任项目。
      if (isCwdUntrusted(targetId, params.cwd)) throw new Error(t('项目未信任，无法启动运行配置'))
      const result = await serverCall(targetId, 'run.start', params)
      const info: RunInfo = {
        runId: result.runId,
        label: params.label ?? params.task.target,
        cwd: params.cwd,
        workdir: params.cwd,
        command: params.task.target,
        pid: result.pid,
        startedAt: Date.now(),
        lastSeq: 0,
        ...(params.key ? { key: params.key } : {}),
      }
      const target = get().targets[targetId] ?? emptyTarget()
      // 事件可能先于响应到达，已有记录时不覆盖。
      if (!target.runs[result.runId]) patchTarget(targetId, { runs: { ...target.runs, [result.runId]: info } })
      scheduleRefresh(targetId)
      return result.runId
    },

    stop: async (targetId, runId) => {
      set((s) => ({ stopped: { ...s.stopped, [runId]: true } }))
      await serverCall(targetId, 'run.stop', { runId })
    },

    clear: (runId) =>
      set((s) => {
        const output = s.outputs[runId]
        return output ? { outputs: { ...s.outputs, [runId]: clearOutput(output) } } : {}
      }),

    hide: (runId) => set((s) => ({ hidden: { ...s.hidden, [runId]: true } })),

    loadConfigs: async (targetId, cwd) => {
      const key = scopeKey(targetId, cwd)
      const isNew = !get().scopes[key]
      set((s) => ({
        scopes: {
          ...s.scopes,
          [key]: { targetId, cwd, data: null, error: null, saving: false, ...s.scopes[key], loading: true },
        },
        watchRevision: isNew ? s.watchRevision + 1 : s.watchRevision,
      }))
      try {
        const data = await loadRunConfigs(targetId, cwd)
        patchScope(key, { data, loading: false, error: null })
      } catch (err) {
        patchScope(key, { loading: false, error: translateMessage(friendlyError(err, t('读取运行配置失败'))) })
      }
    },

    saveConfigs: async (targetId, cwd, configs) => {
      const key = scopeKey(targetId, cwd)
      const scope = get().scopes[key]
      const data = scope?.data
      if (!data) throw new Error(t('运行配置尚未加载'))
      if (data.error) throw new Error(t('run.json 格式错误，请先手动修复后再保存'))
      patchScope(key, { saving: true })
      try {
        const file = { ...data.file, configs }
        const mtimeMs = await saveRunConfigs(
          targetId,
          cwd,
          file,
          data.source === 'qingcode' ? data.mtimeMs : undefined,
        )
        const created = data.source !== 'qingcode'
        set((s) => ({
          scopes: { ...s.scopes, [key]: { ...s.scopes[key]!, saving: false, data: { file, source: 'qingcode', mtimeMs } } },
          // 新建了 .qingcode 目录，需要重新登记监听。
          watchRevision: created ? s.watchRevision + 1 : s.watchRevision,
        }))
      } catch (err) {
        patchScope(key, { saving: false })
        if (err instanceof BackendCallError && err.code === 'conflict') {
          void get().loadConfigs(targetId, cwd)
          throw new Error(t('run.json 已被外部修改，已重新加载，请重试'))
        }
        throw new Error(translateMessage(friendlyError(err, t('保存运行配置失败'))))
      }
    },
  }
})

function applyChunks(runId: string, chunks: RunOutputChunk[], truncated: boolean): void {
  useRunStore.setState((s) => {
    let output = s.outputs[runId] ?? emptyOutput()
    if (truncated) output = markDropped(output)
    for (const chunk of chunks) {
      if (chunk.seq > output.lastSeq) output = appendOutput(output, chunk.data, chunk.stream, chunk.seq)
    }
    return { outputs: { ...s.outputs, [runId]: output } }
  })
}

async function fetchOutput(targetId: string, runId: string): Promise<void> {
  if (fetching.has(runId)) return
  fetching.add(runId)
  try {
    const since = useRunStore.getState().outputs[runId]?.lastSeq ?? 0
    const result = await serverCall(targetId, 'run.output', { runId, sinceSeq: since })
    applyChunks(runId, result.chunks, result.truncated)
  } catch {
    // 记录已被 server 清理或连接中断：保留已有输出即可。
  } finally {
    fetching.delete(runId)
  }
}

function scheduleRefresh(targetId: string): void {
  if (refreshTimers.has(targetId)) return
  refreshTimers.set(
    targetId,
    setTimeout(() => {
      refreshTimers.delete(targetId)
      void refreshRuns(targetId)
    }, 300),
  )
}

/** 只刷新运行记录（不重新拉输出），用于补齐别的客户端启动的 run 与 server 侧的完整命令行。 */
async function refreshRuns(targetId: string): Promise<void> {
  try {
    const result = await serverCall(targetId, 'run.list', {})
    const runs: Record<string, RunInfo> = {}
    for (const run of result.runs) runs[run.runId] = run
    useRunStore.setState((s) => ({
      targets: {
        ...s.targets,
        [targetId]: { ...(s.targets[targetId] ?? emptyTarget()), platform: result.platform, runs, loaded: true, error: null },
      },
    }))
    for (const run of result.runs) {
      const output = useRunStore.getState().outputs[run.runId]
      if (!output || output.lastSeq < run.lastSeq) void fetchOutput(targetId, run.runId)
    }
  } catch {
    // 下次事件或重连时再试。
  }
}

onServerEvt<RunDataEvt>('run.data', (targetId, payload) => {
  if (!payload || typeof payload.runId !== 'string' || typeof payload.seq !== 'number') return
  const state = useRunStore.getState()
  if (!state.targets[targetId]?.runs[payload.runId]) scheduleRefresh(targetId)
  const output = state.outputs[payload.runId]
  const last = output?.lastSeq ?? 0
  if (payload.seq <= last) return
  if (payload.seq > last + 1 || fetching.has(payload.runId)) {
    // 有缺口（断线、刚打开面板）：从缓冲补齐，补齐结果里包含这一块。
    void fetchOutput(targetId, payload.runId)
    return
  }
  applyChunks(payload.runId, [payload], false)
})

onServerEvt<RunExitEvt>('run.exit', (targetId, payload) => {
  if (!payload || typeof payload.runId !== 'string') return
  useRunStore.setState((s) => {
    const target = s.targets[targetId]
    const run = target?.runs[payload.runId]
    if (!target || !run) return {}
    const ended: RunInfo = { ...run, exitCode: payload.exitCode, signal: payload.signal, endedAt: Date.now() }
    return { targets: { ...s.targets, [targetId]: { ...target, runs: { ...target.runs, [payload.runId]: ended } } } }
  })
  // 结束时间、最终 seq 以 server 记录为准。
  scheduleRefresh(targetId)
})

onServerEvt<FsChangedEvt>('fs.changed', (targetId, payload) => {
  const paths = Array.isArray(payload?.paths) ? payload.paths.filter((p): p is string => typeof p === 'string') : []
  if (paths.length === 0) return
  const state = useRunStore.getState()
  for (const scope of Object.values(state.scopes)) {
    if (scope.targetId !== targetId || scope.loading || scope.saving) continue
    if (paths.some((path) => isConfigPath(scope.cwd, path))) void state.loadConfigs(scope.targetId, scope.cwd)
  }
})

// 连接重新就绪：新连接还没登记 run 事件订阅，重新 run.list 并补齐输出。
useTargets.subscribe((state, previous) => {
  if (state.states === previous.states) return
  for (const [id, info] of Object.entries(state.states)) {
    if (info?.state === 'ready' && previous.states[id]?.state !== 'ready' && useRunStore.getState().targets[id]) {
      void useRunStore.getState().init(id)
    }
  }
})

onBackendRestart(() => {
  for (const id of Object.keys(useRunStore.getState().targets)) void useRunStore.getState().init(id)
})

/** fs.watch 由总管合并登记：返回该目标已加载配置的项目根及其 .qingcode 目录。 */
export function getRunWatchPaths(targetId?: string): string[] {
  const paths = new Set<string>()
  for (const scope of Object.values(useRunStore.getState().scopes)) {
    if (targetId !== undefined && scope.targetId !== targetId) continue
    paths.add(scope.cwd)
    paths.add(runConfigPaths(scope.cwd).dir)
  }
  return [...paths].sort()
}

export function subscribeRunWatch(listener: () => void): () => void {
  return useRunStore.subscribe((state, previous) => {
    if (state.watchRevision !== previous.watchRevision) listener()
  })
}

/** 等待一组 run 结束（重启用）；超时返回 false。 */
export function waitForRunsExit(targetId: string, runIds: string[], timeoutMs = 8000): Promise<boolean> {
  const done = (): boolean => {
    const runs = useRunStore.getState().targets[targetId]?.runs ?? {}
    return runIds.every((id) => !runs[id] || runs[id]!.endedAt !== undefined)
  }
  if (done()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
    const unsubscribe = useRunStore.subscribe(() => {
      if (!done()) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
}

/** 面板用：某目标 + 项目根下的运行记录、配置与操作。 */
export function useRun(targetId: string, cwd: string) {
  const target = useRunStore((s) => s.targets[targetId])
  const scope = useRunStore((s) => s.scopes[scopeKey(targetId, cwd)])
  const hidden = useRunStore((s) => s.hidden)
  const stopped = useRunStore((s) => s.stopped)
  const runs = useMemo(
    () => Object.values(target?.runs ?? {}).filter((run) => samePath(run.cwd, cwd)),
    [target?.runs, cwd],
  )
  return {
    platform: target?.platform ?? null,
    runsLoaded: target?.loaded ?? false,
    runsError: target?.error ?? null,
    runs,
    hidden,
    stopped,
    configs: scope?.data?.file.configs ?? null,
    configSource: scope?.data?.source ?? null,
    configError: scope?.data?.error ?? scope?.error ?? null,
    configLoading: scope?.loading ?? true,
    saving: scope?.saving ?? false,
  }
}
