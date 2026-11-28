import { describe, expect, it } from 'vitest'
import { sessionMessagesToThread } from './history'
import { emptyMapState, mapSdkMessage, nextTurnState, type MapState } from './items'
import { applyPlanResult, emptyPlan, trackPlanCall, type PlanTracker } from './plan'
import type { Json } from './v2'

function run(tracker: PlanTracker, id: string, name: string, input: unknown, text: string, structured?: unknown, failed = false) {
  return applyPlanResult(trackPlanCall(tracker, id, name, input), id, { failed, text, structured })
}

const toolUse = (id: string, name: string, input: unknown): Json => ({
  type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id: string, content: string, extra: Json = {}): Json => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra,
})

describe('Claude 计划工具', () => {
  it('TodoWrite 整表替换，失败的调用不应用', () => {
    const todos = [
      { content: '读代码', status: 'completed', activeForm: '读代码中' },
      { content: '改代码', status: 'in_progress', activeForm: '改代码中' },
    ]
    const first = run(emptyPlan(), 'a', 'TodoWrite', { todos }, 'ok')
    expect(first.plan).toEqual([{ step: '读代码', status: 'completed' }, { step: '改代码', status: 'inProgress' }])
    const denied = run(first.tracker, 'b', 'TodoWrite', { todos: [] }, '用户拒绝', undefined, true)
    expect(denied.plan).toBeNull()
    expect(denied.tracker.tasks.size).toBe(2)
    expect(run(denied.tracker, 'c', 'TodoWrite', { todos: [] }, 'ok').plan).toEqual([])
  })

  it('结构化结果按任务 ID 累积、更新和删除', () => {
    let state = run(emptyPlan(), 'a', 'TaskCreate', { subject: '一' }, '', { task: { id: '1', subject: '一' } })
    state = run(state.tracker, 'b', 'TaskCreate', { subject: '二' }, '', { task: { id: '2', subject: '二' } })
    expect(state.plan).toEqual([{ step: '一', status: 'pending' }, { step: '二', status: 'pending' }])
    state = run(state.tracker, 'c', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, '', { success: true, taskId: '1' })
    expect(state.plan?.[0]).toEqual({ step: '一', status: 'inProgress' })
    // 只改依赖关系、失败或指向未知任务时清单不变。
    expect(run(state.tracker, 'd', 'TaskUpdate', { taskId: '1', addBlocks: ['2'] }, '', { success: true }).plan).toBeNull()
    expect(run(state.tracker, 'e', 'TaskUpdate', { taskId: '1', status: 'completed' }, '', { success: false }).plan).toBeNull()
    expect(run(state.tracker, 'f', 'TaskUpdate', { taskId: '9', status: 'completed' }, '', { success: true }).plan).toBeNull()
    state = run(state.tracker, 'g', 'TaskUpdate', { taskId: '2', status: 'deleted' }, '', { success: true })
    expect(state.plan).toEqual([{ step: '一', status: 'inProgress' }])
    const listed = run(state.tracker, 'h', 'TaskList', {}, '', { tasks: [{ id: '3', subject: '三', status: 'completed' }] })
    expect(listed.plan).toEqual([{ step: '三', status: 'completed' }])
  })

  it('历史只有结果正文时仍能认出任务', () => {
    let state = run(emptyPlan(), 'a', 'TaskCreate', { subject: '一' }, 'Task #1 created successfully: 一')
    state = run(state.tracker, 'b', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status')
    expect(state.plan).toEqual([{ step: '一', status: 'completed' }])
    expect(run(state.tracker, 'c', 'TaskUpdate', { taskId: '1', status: 'pending' }, 'Task not found').plan).toBeNull()
    const listed = run(state.tracker, 'd', 'TaskList', {}, '#1 [completed] 一\n#2 [pending] 二 [blocked by #1]')
    expect(listed.plan).toEqual([{ step: '一', status: 'completed' }, { step: '二', status: 'pending' }])
    expect(run(listed.tracker, 'e', 'TaskList', {}, '无法识别的正文').plan).toBeNull()
    expect(run(listed.tracker, 'f', 'TaskList', {}, 'No tasks found').plan).toEqual([])
  })

  it('实时发 turn/plan/updated，清单跨轮保留', () => {
    const apply = (state: MapState, turnId: string, message: Json) =>
      mapSdkMessage(message, { threadId: 'thread', turnId, cwd: '/work' }, state)
    let mapped = apply(emptyMapState(), 'first', toolUse('create', 'TaskCreate', { subject: '一' }))
    mapped = apply(mapped.state, 'first', toolResult('create', '', { tool_use_result: { task: { id: '1', subject: '一' } } }))
    expect(mapped.notifications.find((note) => note.method === 'turn/plan/updated')?.params).toEqual({
      threadId: 'thread', turnId: 'first', explanation: null, plan: [{ step: '一', status: 'pending' }],
    })
    const next = nextTurnState(mapped.state)
    expect(next.turnPlan).toBeUndefined()
    mapped = apply(next, 'second', toolUse('update', 'TaskUpdate', { taskId: '1', status: 'completed' }))
    mapped = apply(mapped.state, 'second', toolResult('update', 'Updated task #1 status'))
    expect(mapped.state.turnPlan).toEqual([{ step: '一', status: 'completed' }])
  })

  it('历史把清单挂在发生变化的轮次上', () => {
    const entry = (uuid: string, message: Json) => ({ uuid, parent_tool_use_id: null, message: message.message })
    const user = (uuid: string, text: string) => entry(uuid, { message: { role: 'user', content: text } })
    const history = sessionMessagesToThread({ id: 's', cwd: '/work' }, [
      user('u1', '开始'),
      entry('a1', toolUse('create', 'TaskCreate', { subject: '一' })),
      entry('r1', toolResult('create', 'Task #1 created successfully: 一')),
      user('u2', '聊聊'),
      user('u3', '做完它'),
      entry('a2', toolUse('update', 'TaskUpdate', { taskId: '1', status: 'completed' })),
      entry('r2', toolResult('update', 'Updated task #1 status')),
    ])
    expect(history.turns.map((turn) => turn.plan)).toEqual([
      { explanation: null, plan: [{ step: '一', status: 'pending' }] },
      undefined,
      { explanation: null, plan: [{ step: '一', status: 'completed' }] },
    ])
    expect([...history.plan.tasks.keys()]).toEqual(['1'])
    expect(history.forkPoints.map((point) => point.promptMessageId)).toEqual(['u1', 'u2', 'u3'])
  })
})
