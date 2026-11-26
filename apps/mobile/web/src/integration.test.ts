// 浏览器开发模式的端到端冒烟：粘贴导入 → 配对 → 目标/项目/多 Agent 会话 → 流式对话 → 模型覆盖 → 只读查看文件/差异。
import { describe, expect, it } from 'vitest'
import { createGateway, setGateway } from './client'
import { MOCK_FP, type MockNativePort } from './mock'
import { useApp } from './store'
import { EventStreamController } from './transport'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('模拟网关全链路', () => {
  it('从剪贴板导入到流式回复都能走通', async () => {
    const gateway = createGateway()
    setGateway(gateway)

    const state = () => useApp.getState()
    state().openAddForm()
    await state().pasteFromClipboard()
    expect(state().form?.draft.fp).toBe(MOCK_FP)
    expect(state().form?.error).toBeNull()

    await state().testConnection()
    expect(state().form?.probe?.fingerprint).toBe(MOCK_FP)
    expect(state().form?.fpMismatch).toBeNull()

    await state().pairAndSave()
    expect(state().connections).toHaveLength(1)
    expect(state().activeId).toBe(state().connections[0]?.id)
    expect(state().targets.map((item) => item.id)).toEqual(['local', 'ssh-93'])

    // 事件流由页面 init 建立，这里手动建立等价的订阅。
    const controller = new EventStreamController(
      gateway,
      () => {
        const current = state()
        return current.connections.find((item) => item.id === current.activeId) ?? null
      },
      {
        onEvent: (event) => state().handleGatewayEvent(event),
        onOpen: () => undefined,
        onClose: () => undefined,
      },
    )
    controller.start()
    await wait(30)

    state().requestConnect('ssh-93')
    expect(state().credential?.targetId).toBe('ssh-93')
    await state().submitCredentials('', false)
    await wait(320)
    expect(state().targetStates['ssh-93']?.state).toBe('ready')

    // 网关把 hostKey.prompt 转成 mobile.notice，手机端要给出电脑确认提示。
    state().handleGatewayEvent({
      name: 'mobile.notice',
      payload: { kind: 'hostKey', message: '请在电脑上确认主机指纹' },
    })
    expect(state().notice).toBe('请在电脑上确认主机指纹')

    await state().selectTarget('local')
    await wait(30)
    expect(state().projects.some((item) => item.id === 'p-local')).toBe(true)
    expect(state().agentSettings?.agents['local']?.pi?.enabled).toBe(true)
    await state().selectProject('p-local')
    expect(state().sessions['codex:local']?.opened).toBe(true)
    expect(state().sessions['claude:local']?.opened).toBe(true)
    // pi 打开失败只记在 pi 名下，Codex / Claude 的会话照常合并显示。
    expect(state().sessions['pi:local']?.opened).toBe(false)
    expect(state().agentErrors.pi).toContain('pi')
    expect(state().threadsError).toBeNull()
    expect(state().threads.map((item) => `${item.agent}:${item.id}`)).toEqual(['codex:t-demo', 'claude:c-demo'])

    // 打开 Claude 会话走 Claude 通道；事件按 payload.agent 路由，不串到 Codex。
    await state().openThread('c-demo', 'claude')
    expect(state().selectedAgent).toBe('claude')
    expect(state().sessions['claude:local']?.state.threads['c-demo']?.items.length).toBeGreaterThan(0)
    expect(state().sessions['codex:local']?.state.threads['c-demo']).toBeUndefined()
    state().goBack()

    await state().newThread()
    expect(state().page).toBe('chat')
    expect(state().selectedAgent).toBe('codex')
    expect(state().selectedThreadId).toBeTruthy()

    // 模型：Codex 有列表，选中后作为 turn/start 覆盖项发送。
    await state().loadModels('local', 'codex')
    expect(state().models['codex:local']?.models.map((item) => item.model)).toEqual(['gpt-5.5-codex', 'gpt-5.5-mini'])
    state().setModelPrefs('local', 'codex', { model: 'gpt-5.5-mini', effort: 'minimal', fast: false })

    await state().send('你好')
    await wait(600)
    const threadId = state().selectedThreadId
    const view = threadId ? state().sessions['codex:local']?.state.threads[threadId] : undefined
    expect(view?.items.some((item) => item.kind === 'user')).toBe(true)
    expect(view?.items.some((item) => item.kind === 'agent' && item.text.includes('模拟的'))).toBe(true)
    expect(view?.items.some((item) => item.kind === 'fileChange')).toBe(true)
    expect(state().rateLimits['local']?.snapshot?.primary?.usedPercent).toBeGreaterThan(0)
    const port = (gateway as unknown as { native: { port: MockNativePort } }).native.port
    expect(port.lastTurnParams).toMatchObject({ agent: 'codex', model: 'gpt-5.5-mini', effort: 'minimal' })
    // turn 完成后的后台刷新不重试打不开的 pi，但保留它的提示。
    expect(state().agentErrors.pi).toContain('pi')

    // Claude 未显式选模型时不带覆盖项。
    await state().newThread('claude')
    expect(state().selectedAgent).toBe('claude')
    await state().loadModels('local', 'claude')
    await state().send('审查一下')
    await wait(50)
    expect(port.lastTurnParams?.agent).toBe('claude')
    expect(port.lastTurnParams?.model).toBeUndefined()
    expect(port.lastTurnParams?.effort).toBeUndefined()
    await wait(600)

    // 只读查看：文本分段续读、行号定位，差异优先 git.diff，失败回退到卡片 diff。
    await state().openFile({ path: 'D:\code\qingcode-next\README.md', line: 3 })
    expect(state().viewer?.file?.truncated).toBe(true)
    expect(state().viewer?.line).toBe(3)
    const firstLength = state().viewer?.file?.length ?? 0
    await state().loadMoreFile()
    expect(state().viewer?.file?.length).toBeGreaterThan(firstLength)
    expect(state().goBack()).toBe(true)
    expect(state().viewer).toBeNull()

    await state().openFile({ path: 'D:\code\missing.ts' })
    expect(state().viewer?.error).toBe('文件不存在或已被删除')
    state().closeViewer()

    await state().openDiff({ path: 'D:\code\qingcode-next\a.ts', diff: '+card' })
    expect(state().viewer?.diffSource).toBe('git')
    expect(state().viewer?.diff).toContain('@@')
    await state().openDiff({ path: 'D:\code\qingcode-next\clean.ts', diff: '+card' })
    expect(state().viewer?.diffSource).toBe('card')
    expect(state().viewer?.diff).toBe('+card')
    state().closeViewer()

    controller.stop()
    for (const session of Object.values(state().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
  }, 15_000)
})
