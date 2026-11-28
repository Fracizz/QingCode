// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { rememberAccessMode } from '../features/access/accessModel'
import type { Attachment } from '../lib/attachments'
import { useRunningSend } from '../features/settings/runningSend'
import { useCodex } from '../store/codex'
import { Composer } from './Composer'
import { TooltipProvider } from './primitives'

it.each(['selection', 'annotation', 'attachment'] as const)('快捷标签保留已有草稿（%s）', async (draftType) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onSend = vi.fn()
  const boundary = createRef<HTMLDivElement>()
  const text = '检查\n继续'
  const entries = [{ id: 'review', name: '检查', text, send: true }]
  const attachments: Attachment[] = draftType === 'attachment'
    ? [{ id: 'a', name: 'a.txt', kind: 'file', size: 1, localPath: '/a.txt', targetPath: '/a.txt', status: 'ready' }]
    : []
  function Harness() {
    const [value, onChange] = useState(draftType === 'selection' ? 'abcDEF' : '')
    return <Composer agent="codex" suggestionBoundaryRef={boundary} value={value} onChange={onChange}
      shortcuts={{ entries, sendBlocked: false, queued: false }}
      annotationCount={draftType === 'annotation' ? 1 : 0}
      attach={{ attachments, imageSupport: { allowed: true, reason: null }, onAddFiles: () => [], onRemoveAttachment: vi.fn() }}
      onSend={onSend} onInterrupt={vi.fn()} running={false} sending={false} error={null} onClearError={vi.fn()} />
  }
  try {
    await act(() => root.render(<TooltipProvider><Harness /></TooltipProvider>))
    const area = host.querySelector('textarea')!
    const shortcut = host.querySelector<HTMLButtonElement>('button[aria-label="检查 · 填入文字"]')!
    await act(() => {
      if (draftType === 'selection') {
        area.focus()
        area.setSelectionRange(1, 3)
      }
      shortcut.focus()
      shortcut.click()
    })
    expect(area.value).toBe(draftType === 'selection' ? `abc${text}DEF` : text)
    expect(area.selectionStart).toBe((draftType === 'selection' ? 3 : 0) + text.length)
    expect(document.activeElement).toBe(area)
    expect(onSend).not.toHaveBeenCalled()
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('空草稿用 Tab 填入提示词建议，发送仍走原来的操作', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onSend = vi.fn()
  const boundary = createRef<HTMLDivElement>()
  const suggestion = '继续跑测试'
  function Harness() {
    const [value, onChange] = useState('')
    return <Composer agent="claude" suggestionBoundaryRef={boundary} value={value} onChange={onChange}
      promptSuggestion={suggestion} onSend={onSend} onInterrupt={vi.fn()} running={false} sending={false}
      error={null} onClearError={vi.fn()} />
  }
  try {
    await act(() => root.render(<TooltipProvider><Harness /></TooltipProvider>))
    const textarea = host.querySelector('textarea')!
    const option = '[aria-label="填入建议：继续跑测试"]'
    expect(host.querySelector(option)).not.toBeNull()
    expect(textarea.value).toBe('')

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(() => { textarea.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(true)
    expect(textarea.value).toBe(suggestion)
    expect(host.querySelector(option)).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

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
          skills: [], knownSkills: [], onSkillsChange: vi.fn(), onCommand, onOpen,
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
  const onInterrupt = vi.fn()
  const render = (value: string, patch: { steerBlocked?: boolean; running?: boolean } = {}) => act(() => root.render(
    <TooltipProvider>
      <Composer suggestionBoundaryRef={createRef<HTMLDivElement>()} agent="codex" value={value} onChange={() => {}}
        onSend={onSend} onInterrupt={onInterrupt} running sending={false} error={null} onClearError={() => {}} {...patch} />
    </TooltipProvider>,
  ))
  const enter = (options: KeyboardEventInit = {}) => act(() => {
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }))
  })
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  try {
    await render('')
    expect(button('引导')).toBeNull()
    await act(() => button('停止运行')!.click())
    expect(onInterrupt).toHaveBeenCalledOnce()

    await render('补充')
    expect(button('停止运行')).not.toBeNull()
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
