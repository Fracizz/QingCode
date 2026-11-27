import type { WorkspaceContext, WorkspaceHandlers } from '../registry'
import { WorkspaceError } from '../registry'
import { parseStartParams } from './logic'
import { RunManager } from './manager'

// daemon 内唯一一份：进程跟 daemon 走，不跟某个客户端连接走。
let manager: RunManager | null = null

function getManager(ctx: WorkspaceContext): RunManager {
  manager ??= new RunManager({ log: (message) => ctx.log(message) })
  manager.subscribe(ctx)
  return manager
}

/** 运行中的任务数；daemon 空闲退出判断可据此避免丢掉托管进程。 */
export function activeRunCount(): number {
  return manager?.activeCount() ?? 0
}

function requireRunId(p: Record<string, unknown>): string {
  if (typeof p.runId !== 'string' || !p.runId) throw new WorkspaceError('params', 'runId 必须是非空字符串')
  return p.runId
}

export const runHandlers: WorkspaceHandlers = {
  'run.start': async (p, ctx) => getManager(ctx).start(parseStartParams(p)),
  'run.stop': async (p, ctx) => {
    const runId = requireRunId(p)
    await getManager(ctx).stop(runId)
    return {}
  },
  'run.list': async (_p, ctx) => {
    const runs = getManager(ctx)
    return { platform: runs.targetOs, runs: runs.list() }
  },
  'run.output': async (p, ctx) => {
    const runId = requireRunId(p)
    const since = p.sinceSeq
    if (since !== undefined && since !== null && (typeof since !== 'number' || !Number.isFinite(since))) {
      throw new WorkspaceError('params', 'sinceSeq 必须是数字')
    }
    return getManager(ctx).output(runId, typeof since === 'number' ? since : 0)
  },
}
