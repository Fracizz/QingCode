import { describe, expect, it, vi } from 'vitest'
import {
  backgroundTaskTypeLabel, listBackgroundTasks, listSlashCommands, mergeSlashCommands, parseBackgroundTasks,
  rewindFiles, stopBackgroundTask,
} from './agentControls'
import type { CodexRpcLike } from './api'
import {
  applyBackgroundTaskList, applyNotification, emptyState, failActiveThreads, loadThread, type ConversationState,
} from './conversation'
import type { ServerNotification } from './codex-types'

const task = { id: 'build', type: 'local_bash', description: '构建' }
const notify = (state: ConversationState, method: string, params: unknown) =>
  applyNotification(state, { method, params } as unknown as ServerNotification)
const updated = (state: ConversationState, tasks: unknown[]) =>
  notify(state, 'qingcode/backgroundTasks/updated', { threadId: 't', tasks })
const rpcWith = (result: unknown) => {
  const request = vi.fn(async (_method: string, _params: unknown) => result)
  return { request, rpc: { request } as unknown as CodexRpcLike }
}

describe('后台任务', () => {
  it('解析时丢弃缺少 ID 的条目', () => {
    expect(parseBackgroundTasks([task, { type: 'x' }, null])).toEqual([task])
    expect(parseBackgroundTasks(undefined)).toEqual([])
    expect(backgroundTaskTypeLabel('local_bash')).toBe('命令')
    expect(backgroundTaskTypeLabel('other_kind')).toBe('other_kind')
    expect(backgroundTaskTypeLabel('')).toBe('任务')
  })

  it('通知全量替换，没打开过的会话收到空列表不建视图', () => {
    const empty = emptyState()
    expect(updated(empty, [])).toBe(empty)
    const running = updated(empty, [task])
    expect(running.threads.t?.backgroundTasks).toEqual([task])
    expect(running.threads.t?.status).toBe('idle')
    expect(updated(running, []).threads.t?.backgroundTasks).toEqual([])
  })

  it('重新载入历史保留任务；进程退出和会话关闭时清除', () => {
    const state = updated(emptyState(), [task])
    expect(loadThread(state, { id: 't', turns: [] }).threads.t?.backgroundTasks).toEqual([task])
    const failed = failActiveThreads(state, '进程退出').threads.t!
    expect(failed.backgroundTasks).toBeUndefined()
    // 只有后台任务的空闲会话不应显示为失败。
    expect(failed.status).toBe('idle')
    expect(notify(state, 'thread/closed', { threadId: 't' }).threads.t?.backgroundTasks).toBeUndefined()
  })

  it('列表回包比期间收到的通知旧时丢弃', () => {
    const state = loadThread(emptyState(), { id: 't', turns: [] })
    expect(applyBackgroundTaskList(state, 't', [], undefined)).toBe(state)
    expect(applyBackgroundTaskList(state, 't', [task], undefined).threads.t?.backgroundTasks).toEqual([task])
    const notified = updated(state, [])
    expect(applyBackgroundTaskList(notified, 't', [task], undefined)).toBe(notified)
    expect(applyBackgroundTaskList(state, 'missing', [task], undefined)).toBe(state)
  })

  it('列出与停止走 qingcode 方法', async () => {
    const list = rpcWith({ tasks: [task] })
    expect(await listBackgroundTasks(list.rpc, 't')).toEqual([task])
    expect(list.request).toHaveBeenCalledWith('qingcode/backgroundTasks/list', { threadId: 't' })
    const stop = rpcWith({})
    await stopBackgroundTask(stop.rpc, 't', 'build')
    expect(stop.request).toHaveBeenCalledWith('qingcode/backgroundTasks/stop', { threadId: 't', taskId: 'build' })
  })
})

describe('原生斜杠命令', () => {
  it('解析命令名与参数说明', async () => {
    const { rpc } = rpcWith({ commands: [
      { name: '/review', description: '评审', argumentHint: '<文件>' }, { name: '' }, { name: 'plain' },
    ] })
    expect(await listSlashCommands(rpc, 't')).toEqual([
      { name: 'review', description: '评审', argumentHint: '<文件>' }, { name: 'plain', description: '' },
    ])
    expect(await listSlashCommands(rpcWith({}).rpc, 't')).toEqual([])
  })

  it('内置命令优先，已列出的技能与重复项不再出现', () => {
    const names = ['help', 'compact', 'commit', 'skill:deploy', 'skill:unlisted', 'review', 'review']
    expect(mergeSlashCommands(names.map((name) => ({ name, description: '' })), ['commit', 'deploy']).map(({ name }) => name))
      .toEqual(['skill:unlisted', 'review'])
  })
})

describe('文件回滚', () => {
  it('回包补齐缺省字段，保留部分跳过的说明', async () => {
    const partial = rpcWith({ canRewind: true, filesChanged: ['a.ts', 3], insertions: 2, deletions: -1, error: '有 1 个链接类文件未恢复' })
    expect(await rewindFiles(partial.rpc, 't', 'u', true)).toEqual({
      canRewind: true, filesChanged: ['a.ts', '3'].slice(0, 1), insertions: 2, deletions: 0, error: '有 1 个链接类文件未恢复',
    })
    expect(partial.request).toHaveBeenCalledWith('qingcode/files/rewind', { threadId: 't', turnId: 'u', dryRun: true })
    expect(await rewindFiles(rpcWith(null).rpc, 't', 'u', false))
      .toEqual({ canRewind: false, filesChanged: [], insertions: 0, deletions: 0 })
  })
})
