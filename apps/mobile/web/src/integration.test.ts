// 浏览器开发模式的端到端冒烟：粘贴导入 → 配对 → 目标/项目/会话 → 流式对话。
import { describe, expect, it, vi } from 'vitest'
import { createGateway, setGateway } from './client'
import { buildConnectionInfo } from './link'
import { MOCK_FP } from './mock'
import { parseConnections } from './state'
import { useApp } from './store'
import { EventStreamController } from './transport'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('模拟网关全链路', () => {
  it('从剪贴板导入到流式回复都能走通', async () => {
    const gateway = createGateway()
    const pair = vi.spyOn(gateway, 'pair')
    setGateway(gateway)

    const state = () => useApp.getState()
    state().openAddForm()
    await state().pasteFromClipboard()
    expect(state().form?.draft.fp).toBe(MOCK_FP)
    expect(state().form?.error).toBeNull()
    expect(state().form?.paste).toBe('')
    state().updateDraft('name', '我的电脑')

    await state().testConnection()
    expect(state().form?.probe?.fingerprint).toBe(MOCK_FP)
    expect(state().form?.fpMismatch).toBeNull()

    await state().pairAndSave()
    expect(state().connections).toHaveLength(1)
    expect(state().activeId).toBe(state().connections[0]?.id)
    expect(state().targets.map((item) => item.id)).toEqual(['local', 'ssh-93'])

    const original = state().connections[0]!
    state().openEditForm(original.id)
    const forwarded = { name: original.name, host: 'frp.example.com', port: 7001, code: 'mock1234' }
    state().setFormPaste(buildConnectionInfo({ ...forwarded, fp: 'ef'.repeat(32) }).text)
    state().parsePaste()
    expect(state().form?.error).toContain('证书指纹不同')
    expect(state().form?.draft.host).toBe(original.host)
    state().setFormPaste(buildConnectionInfo({ ...forwarded, fp: MOCK_FP }).text)
    state().parsePaste()
    expect(state().form?.draft).toMatchObject({ host: 'frp.example.com', port: '7001', code: '' })
    state().updateDraft('name', '转发后的电脑')
    state().updateDraft('port', '')
    expect(state().form?.draft.port).toBe('')
    await state().saveEdit()
    expect(state().form?.error).toContain('端口')
    state().updateDraft('port', '7002')
    await state().testConnection()
    expect(state().form?.probe?.fingerprint).toBe(MOCK_FP)
    vi.spyOn(gateway, 'storageSet').mockRejectedValueOnce(new Error('本地存储暂不可用'))
    await state().saveEdit()
    expect(state().form?.error).toBe('本地存储暂不可用')
    expect(state().connections[0]).toEqual(original)
    await state().saveEdit()
    expect(state().page).toBe('targets')
    const edited = { ...original, name: '转发后的电脑', host: 'frp.example.com', port: 7002 }
    expect(state().connections[0]).toEqual(edited)
    expect(parseConnections(await gateway.storageGet('connections'))).toEqual([edited])
    expect(pair).toHaveBeenCalledTimes(1)

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
    expect(state().projects.some((item) => item.id === 'p-local')).toBe(true)
    await state().selectProject('p-local')
    expect(state().sessions['local']?.opened).toBe(true)
    expect(state().threads.length).toBeGreaterThan(0)

    await state().newThread()
    expect(state().page).toBe('chat')
    expect(state().selectedThreadId).toBeTruthy()

    await state().send('你好')
    await wait(600)
    const threadId = state().selectedThreadId
    const view = threadId ? state().sessions['local']?.state.threads[threadId] : undefined
    expect(view?.items.some((item) => item.kind === 'user')).toBe(true)
    expect(
      view?.items.some((item) => item.kind === 'agent' && item.text.includes('模拟的')),
    ).toBe(true)
    expect(state().rateLimits['local']?.snapshot?.primary?.usedPercent).toBeGreaterThan(0)

    controller.stop()
    for (const session of Object.values(state().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
  }, 15_000)
})
