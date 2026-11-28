// @vitest-environment jsdom
import { act, type PropsWithChildren, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalView, FileRewindResult } from '@qn/codex-client'
import { ApprovalCard } from './ApprovalCard'
import { PlanPanel } from './PlanPanel'
import { RewindDialog } from './RewindDialog'

const rewind = vi.hoisted(() => vi.fn<(chat: unknown, turnId: string, dryRun: boolean) => Promise<FileRewindResult>>())

vi.mock('../store/codex', () => ({
  useCodex: (select: (state: { rewindFiles: typeof rewind }) => unknown) => select({ rewindFiles: rewind }),
}))
vi.mock('./MessageItem', () => ({ ReplyMarkdown: ({ text }: { text: string }) => <div data-markdown>{text}</div> }))
vi.mock('./ui', () => ({
  Badge: ({ children }: PropsWithChildren) => <span>{children}</span>,
  ErrorNote: ({ message }: { message: string }) => <p role="alert">{message}</p>,
  Modal: ({ title, description, children, footer }: PropsWithChildren<{ title: string; description?: ReactNode; footer?: ReactNode }>) =>
    <div role="dialog"><h2>{title}</h2><p>{description}</p>{children}{footer}</div>,
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  rewind.mockReset()
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const button = (label: string) => Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)

describe('计划审批卡', () => {
  const approval = {
    requestId: 'a', threadId: 't', kind: 'command', title: '命令执行审批', detail: '$ ExitPlanMode {"plan":"截断…',
    method: 'item/commandExecution/requestApproval', raw: {},
  } as ApprovalView

  it('展示完整计划，只提供批准与继续规划，不自动应答', async () => {
    const onDecide = vi.fn()
    const plan = '步骤。'.repeat(400)
    await act(() => root.render(<ApprovalCard approval={approval} plan={plan} onDecide={onDecide} />))
    expect(host.querySelector('[data-markdown]')?.textContent).toBe(plan)
    expect(button('本会话允许')).toBeUndefined()
    expect(onDecide).not.toHaveBeenCalled()
    await act(() => button('继续规划')!.click())
    await act(() => button('批准计划')!.click())
    expect(onDecide.mock.calls).toEqual([['decline'], ['accept']])
  })

  it('取不到计划时显示原始参数摘要', async () => {
    await act(() => root.render(<ApprovalCard approval={approval} plan="" onDecide={vi.fn()} />))
    expect(host.textContent).toContain(approval.detail)
  })
})

describe('回滚文件确认框', () => {
  const chat = { targetId: 'local', agent: 'claude', threadId: 't' } as const
  const result = (patch: Partial<FileRewindResult> = {}): FileRewindResult =>
    ({ canRewind: true, filesChanged: ['src/a.ts'], insertions: 3, deletions: 1, ...patch })
  const render = () => act(async () => { root.render(<RewindDialog chat={chat} turnId="turn-1" onClose={vi.fn()} />) })

  it('先试运行并说明范围，确认后才真正回滚', async () => {
    rewind.mockResolvedValueOnce(result({ error: '有 1 个链接类文件未恢复' })).mockResolvedValueOnce(result({ filesChanged: [] }))
    await render()
    expect(rewind.mock.calls.map(([, , dryRun]) => dryRun)).toEqual([true])
    expect(host.textContent).toContain('Bash 与子代理改动基本不回滚，对话不回退')
    expect(host.textContent).toContain('src/a.ts')
    expect(host.textContent).toContain('链接类文件未恢复')
    await act(async () => { button('确认回滚')!.click() })
    expect(rewind.mock.calls.map(([, , dryRun]) => dryRun)).toEqual([true, false])
    expect(host.textContent).toContain('文件已回滚')
  })

  it.each([
    ['不能回滚', result({ canRewind: false, error: '该轮没有可回滚的用户消息' }), '该轮没有可回滚的用户消息'],
    ['没有改动', result({ filesChanged: [] }), '没有需要回滚的文件'],
  ])('%s时不能确认', async (_name, preview, text) => {
    rewind.mockResolvedValue(preview)
    await render()
    expect(host.textContent).toContain(text)
    expect(button('确认回滚')!.disabled).toBe(true)
  })

  it('检查失败时显示原因并可重新检查', async () => {
    rewind.mockRejectedValueOnce(new Error('请先停止当前轮次')).mockResolvedValueOnce(result())
    await render()
    expect(host.textContent).toContain('请先停止当前轮次')
    await act(async () => { button('重新检查')!.click() })
    expect(host.textContent).toContain('src/a.ts')
    expect(rewind.mock.calls.every(([, , dryRun]) => dryRun)).toBe(true)
  })
})

describe('计划清单', () => {
  it('空清单不显示，展开后列出各步状态', async () => {
    await act(() => root.render(<PlanPanel plan={{ turnId: 'u', explanation: null, steps: [] }} running={false} />))
    expect(host.textContent).toBe('')
    await act(() => root.render(<PlanPanel running={false} plan={{ turnId: 'u', explanation: null, steps: [
      { step: '读代码', status: 'completed' }, { step: '改代码', status: 'inProgress' },
    ] }} />))
    expect(host.textContent).toContain('任务清单 1/2')
    expect(host.textContent).toContain('改代码')
    expect(host.querySelectorAll('li')).toHaveLength(0)
    await act(() => host.querySelector('button')!.click())
    expect(host.querySelectorAll('li')).toHaveLength(2)
  })
})
