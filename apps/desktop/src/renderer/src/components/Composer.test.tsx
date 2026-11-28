// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { rememberAccessMode } from '../features/access/accessModel'
import { useRunningSend } from '../features/settings/runningSend'
import { useCodex } from '../store/codex'
import { Composer } from './Composer'
import { TooltipProvider } from './primitives'

it('原生命令写进输入框、打开菜单时刷新；计划模式常驻标识并可退出', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useCodex.getState()
  const setAccessMode = vi.fn()
  const address = { targetId: 'local', agent: 'claude', threadId: 't' } as const
  useCodex.setState({
    currentTargetId: 'local', currentThreadId: 't', setAccessMode,
    access: rememberAccessMode(rememberAccessMode(initial.access, address, 'auto'), address, 'plan'),
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onChange = vi.fn()
  const onOpen = vi.fn()
  const onCommand = vi.fn()
  function Typed() {
    const [value, setValue] = useState('')
    return (
      <Composer suggestionBoundaryRef={createRef<HTMLDivElement>()} agent="claude" value={value}
        onChange={(next) => { onChange(next); setValue(next) }}
        onSend={vi.fn()} onInterrupt={() => {}} running={false} sending={false} error={null} onClearError={() => {}}
        slash={{
          items: [{ id: 'native:review', kind: 'native', name: 'review', description: '评审', argumentHint: '<文件>' }],
          skills: [], onSkillsChange: vi.fn(), onCommand, onOpen,
        }} />
    )
  }
  try {
    await act(() => root.render(<TooltipProvider><Typed /></TooltipProvider>))

    expect(host.querySelector('[role="status"]')?.textContent).toContain('计划模式')
    await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="退出计划模式"]')!.click())
    expect(setAccessMode).toHaveBeenCalledWith(address, expect.any(Number), 'auto')
    expect(onOpen).not.toHaveBeenCalled()

    const area = host.querySelector('textarea')!
    await act(() => {
      // 走原生 setter，让 React 把这次赋值当作用户输入。
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '/rev')
      area.setSelectionRange(4, 4)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledOnce()
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((node) => node.textContent?.includes('/review'))!
    expect(option.textContent).toContain('<文件>')
    await act(() => option.click())
    expect(onChange).toHaveBeenLastCalledWith('/review ')
    expect(onCommand).not.toHaveBeenCalled()
  } finally {
    await act(() => root.unmount())
    useCodex.setState(initial, true)
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('运行中按设置发送，另一组快捷键临时换方式，不能引导时按钮显示排队', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const initial = useRunningSend.getState()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onSend = vi.fn()
  const render = (value: string, patch: { steerBlocked?: boolean; running?: boolean } = {}) => act(() => root.render(
    <TooltipProvider>
      <Composer suggestionBoundaryRef={createRef<HTMLDivElement>()} agent="codex" value={value} onChange={() => {}}
        onSend={onSend} onInterrupt={() => {}} running sending={false} error={null} onClearError={() => {}} {...patch} />
    </TooltipProvider>,
  ))
  const enter = (options: KeyboardEventInit = {}) => act(() => {
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }))
  })
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  try {
    await render('补充')
    expect(button('引导')).not.toBeNull()
    await enter()
    await enter({ ctrlKey: true })
    expect(onSend.mock.calls.map(([, mode]) => mode)).toEqual(['steer', 'queue'])

    await render('补充', { steerBlocked: true })
    expect(button('排队')).not.toBeNull()
    await render('/review')
    expect(button('排队')).not.toBeNull()

    onSend.mockClear()
    await act(() => useRunningSend.setState({ preference: 'interrupt' }))
    await render('补充')
    await act(() => button('打断后发送')!.click())
    await act(() => useRunningSend.setState({ preference: 'queue' }))
    await enter()
    await enter({ ctrlKey: true })
    await render('补充', { running: false })
    await enter()
    await enter({ ctrlKey: true })
    expect(onSend.mock.calls.map(([, mode]) => mode)).toEqual(['immediate', 'queue', 'steer', 'queue'])
  } finally {
    await act(() => root.unmount())
    useRunningSend.setState(initial)
    host.remove()
    vi.unstubAllGlobals()
  }
})
