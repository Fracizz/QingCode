import { useEffect } from 'react'
import type { Project } from '../types'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import { useRunConfigStore } from '../store/runConfigStore'
import { useSshWarmupStore } from '../store/sshWarmupStore'
import { applyRunConfigSessionRestorePolicy } from '../lib/runConfigRuntime'
import { autoReattachLanes, hasPendingReattach } from '../lib/terminal/terminalAutoReattach'
import {
  isTerminalAutoReattachEnabled,
  loadTerminalAutoReattachEnabled,
} from '../lib/terminalAutoReattachSettings'
import { createProjectTrustChecker, isProjectTrusted } from '../lib/workspaceTrust'
import { getSshServerEnabled } from '../lib/sshServerSettings'
import {
  ensureSshWorkspaceConnected,
  isSshBackgroundSuspended,
  isSshProject,
  prepareSshWorkspace,
  sshConnectionIdFromUri,
} from '../lib/sshWorkspace'
import { hasBackend } from '../lib/runtimeCapabilities'
import { shouldRestoreWorkspace } from '../lib/windowSession'

/** 同时接回的连接数上限：保存了大量连接时不在启动瞬间并发过多 SSH。 */
export const AUTO_REATTACH_CONCURRENCY = 4
/** 等首屏与启动恢复的项目先跑起来，后台接回不和它们抢资源。 */
const AUTO_REATTACH_START_DELAY_MS = 1500

/**
 * 接回一个项目的终端：连上并准备好远端服务后，先接回远端没有标签的遗留终端，
 * 再按运行配置的会话策略接回待恢复标签。所有失败都静默，切到项目时按原流程处理。
 */
async function reattachProject(project: Project, signal: AbortSignal, connected: boolean) {
  if (signal.aborted || !isTerminalAutoReattachEnabled() || !isProjectTrusted(project)) return
  if (isSshProject(project)) {
    const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
    if (!connectionId || isSshBackgroundSuspended(connectionId)) return
    if (!connected) {
      await ensureSshWorkspaceConnected(project, { background: true, signal })
      signal.throwIfAborted()
      await prepareSshWorkspace(project.path, signal, () => {}, { project, background: true })
      signal.throwIfAborted()
    }
    await useTerminalStore.getState().syncDetachedTerminals(project.id)
    signal.throwIfAborted()
  }
  if (!hasPendingReattach(project.id, useTerminalStore.getState().terminals)) return
  const configs = await useRunConfigStore.getState().loadConfigs(project)
  signal.throwIfAborted()
  await applyRunConfigSessionRestorePolicy(project.id, configs)
  signal.throwIfAborted()
  await useTerminalStore.getState().spawnRestoredTerminals(project.id, { background: true })
}

/**
 * 启动后在后台自动接回终端（全局开关 `qingcode.session.autoReattachTerminals`）：
 * 不弹提示、不切换项目、不抢焦点。后台预热把某个项目准备就绪时（含断线后重新就绪）也顺带接回。
 */
export function useTerminalAutoReattach(ready: boolean) {
  useEffect(() => {
    if (!ready || !hasBackend() || !shouldRestoreWorkspace()) return
    const controller = new AbortController()
    const { signal } = controller
    const inFlight = new Set<string>()

    const run = async (project: Project, connected: boolean) => {
      if (inFlight.has(project.id)) return
      inFlight.add(project.id)
      try {
        await reattachProject(project, signal, connected)
      } catch {
        // 主机离线、未保存密码、服务准备失败等：保持待恢复，切到项目时再接回。
      } finally {
        inFlight.delete(project.id)
      }
    }

    const timer = setTimeout(() => {
      void (async () => {
        if (!(await loadTerminalAutoReattachEnabled()) || signal.aborted) return
        const state = useProjectStore.getState()
        const lanes = autoReattachLanes(
          state.projects,
          state.sshConnections,
          useTerminalStore.getState().terminals,
          {
            serverEnabled: getSshServerEnabled(),
            trusted: createProjectTrustChecker(),
            suspended: isSshBackgroundSuspended,
          },
        )
        let next = 0
        // 各连接互不等待：不可达的主机只占一个并发名额。
        const worker = async () => {
          while (next < lanes.length && !signal.aborted) {
            for (const project of lanes[next++]) {
              if (signal.aborted) return
              await run(project, false)
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(AUTO_REATTACH_CONCURRENCY, lanes.length) }, worker),
        )
      })()
    }, AUTO_REATTACH_START_DELAY_MS)

    const unsubscribe = useSshWarmupStore.subscribe((state, previous) => {
      if (signal.aborted || !isTerminalAutoReattachEnabled()) return
      for (const [rootUri, status] of state.statuses) {
        if (status.phase !== 'ready' || previous.statuses.get(rootUri)?.phase === 'ready') continue
        const project = useProjectStore.getState().projects.find(candidate => candidate.path === rootUri)
        if (project && !project.ephemeral) void run(project, true)
      }
    })

    return () => {
      controller.abort()
      clearTimeout(timer)
      unsubscribe()
    }
  }, [ready])
}
