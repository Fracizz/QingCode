// @vitest-environment jsdom
import { CodexRpc, type ApprovalView, type ThreadView, type UserInput } from '@qn/codex-client'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { type AgentSession, useApp } from '../store'
import { MobileCodexTransport } from '../transport'
import { ApprovalCard } from './ApprovalCard'
import { BackgroundTasks } from './BackgroundTasks'
import { Composer } from './Composer'
import { PlanPanel } from './PlanPanel'

it('原生命令并入命令菜单，内置命令优先；计划模式在输入区常驻并可退出', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onSend = vi.fn<(text: string, attachments: UserInput[]) => Promise<boolean>>().mockResolvedValue(true)
  const opened = vi.fn()
  const exit = vi.fn()
  function Harness() {
    const [text, setText] = useState('')
    return <Composer draftKey="native-test" agent="claude" text={text} onChangeText={setText} onSend={onSend} onInterrupt={() => {}}
      running={false} sending={false} annotations={[]} onUpdateAnnotation={() => {}} onRemoveAnnotation={() => {}}
      quoteDraft={null} onConfirmQuote={() => {}} onCancelQuote={() => {}} canSteer={false}
      commands={{ run: () => {}, unavailable: () => null }} onCommandMenuOpen={opened}
      nativeCommands={[{ name: 'plugin:review', description: '审查改动', argumentHint: '[范围]' }]}
      planMode={{ disabled: false, onExit: exit }} />
  }
  const textarea = () => host.querySelector('textarea')!
  const type = async (value: string) => {
    const input = textarea()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.setSelectionRange(value.length, value.length)
    await act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const options = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="对话命令"] button')]
  try {
    await act(() => root.render(<Harness />))
    expect(host.querySelector('.qn-plan-mode')?.textContent).toContain('计划模式')
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="退出计划模式"]')!.click())
    expect(exit).toHaveBeenCalledOnce()

    await type('/plugin:re')
    expect(opened).toHaveBeenCalledOnce()
    expect(options().map((button) => button.textContent)).toEqual([expect.stringContaining('/plugin:review[范围]审查改动')])
    await act(() => options()[0]!.click())
    expect(textarea().value).toBe('/plugin:review ')
    await type('/plugin:review 本次改动')
    await act(() => host.querySelector<HTMLButtonElement>('.qn-send-button')!.click())
    // 原生命令随正文发送，不拆成技能输入。
    expect(onSend).toHaveBeenCalledWith('/plugin:review 本次改动', [], 'queue')
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('计划审批显示完整计划，只提供批准与继续规划', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const decide = vi.fn()
  const approval: ApprovalView = {
    requestId: 1, threadId: 't', kind: 'command', title: '命令执行审批', detail: 'ExitPlanMode {}',
    method: 'item/commandExecution/requestApproval', raw: { params: {} },
  }
  const plan = `# 方案\n\n${Array.from({ length: 60 }, (_, index) => `${index + 1}. 步骤 ${index + 1}`).join('\n')}`
  try {
    await act(() => root.render(<ApprovalCard approval={approval} agent="claude" plan={plan} submitting={false} offline={false} onDecide={decide} />))
    expect(host.querySelector('h1')?.textContent).toBe('方案')
    expect(host.querySelectorAll('li')).toHaveLength(60)
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['批准计划', '继续规划'])
    expect(decide).not.toHaveBeenCalled()
    await act(() => host.querySelectorAll('button')[1]!.click())
    expect(decide).toHaveBeenCalledExactlyOnceWith('decline')
    // 取不到计划正文时退回审批摘要。
    await act(() => root.render(<ApprovalCard approval={approval} agent="claude" plan="" submitting={false} offline={false} onDecide={decide} />))
    expect(host.querySelector('pre')?.textContent).toBe('ExitPlanMode {}')
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('任务清单显示进度；后台任务按能力显示，停止失败后可再次点击', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useApp.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const transport = new MobileCodexTransport('local', async () => undefined, 'claude')
  const rpc = new CodexRpc(transport)
  const thread: ThreadView = {
    id: 'bg', status: 'idle', activeTurnId: null, items: [], pendingApprovals: [],
    backgroundTasks: [{ id: 'build', type: 'local_bash', description: '构建' }],
  }
  const session: AgentSession = {
    key: 'claude:local', agent: 'claude', targetId: 'local', rpc, transport,
    opened: true, opening: false, openError: null, lastSeq: null,
    resumedCodexThreads: new Set(), loadedThreads: new Set(), state: { threads: { bg: thread } },
  }
  const refresh = vi.fn().mockResolvedValue(undefined)
  const stop = vi.fn().mockResolvedValue(false)
  try {
    await act(() => {
      useApp.setState({ selectedTargetId: 'local', selectedAgent: 'claude', selectedThreadId: 'bg', eventsConnected: true,
        sessions: { [session.key]: session }, refreshBackgroundTasks: refresh, stopBackgroundTask: stop })
      root.render(<>
        <PlanPanel running plan={{ turnId: 'u', explanation: null, steps: [
          { step: '读代码', status: 'completed' }, { step: '改代码', status: 'inProgress' },
        ] }} />
        <BackgroundTasks />
      </>)
    })
    expect(host.querySelector('[aria-label="任务清单"] summary')?.textContent).toBe('任务清单 1/2改代码')
    expect(refresh).toHaveBeenCalledOnce()
    const button = () => host.querySelector<HTMLButtonElement>('[aria-label="停止任务 构建"]')!
    await act(async () => { button().click() })
    expect(stop).toHaveBeenCalledExactlyOnceWith('build')
    expect(button().disabled).toBe(false)
    // 没有后台任务能力的 Agent 不显示入口。
    await act(() => useApp.setState({ selectedAgent: 'codex', sessions: { 'codex:local': { ...session, key: 'codex:local', agent: 'codex' } } }))
    expect(host.querySelector('[aria-label="后台任务"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    useApp.setState(initial)
    rpc.dispose()
    vi.unstubAllGlobals()
  }
})
