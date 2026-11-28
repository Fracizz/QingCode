// @vitest-environment jsdom
import type { UserInput } from '@qn/codex-client'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useMobilePreferences } from '../mobilePreferences'
import type { SendMode } from '../store'
import { Composer } from './Composer'

const skill = { name: 'pdf', description: '处理 PDF', scope: '用户', path: '/skills/pdf/SKILL.md' }

it('输入 / 列出技能，选中后以 /名字 留在输入框里，发送时拆成 skill 输入', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onSend = vi.fn<(text: string, attachments: UserInput[]) => Promise<boolean>>().mockResolvedValue(true)
  function Harness() {
    const [text, setText] = useState('')
    return <Composer draftKey="skills-test" text={text} onChangeText={setText} onSend={onSend} onInterrupt={() => {}}
      running={false} sending={false} annotations={[]} onUpdateAnnotation={() => {}} onRemoveAnnotation={() => {}}
      quoteDraft={null} onConfirmQuote={() => {}} onCancelQuote={() => {}} canSteer={false}
      commands={{ run: () => {}, unavailable: () => null }} skills={[skill]} />
  }
  const textarea = () => host.querySelector('textarea')!
  const type = async (value: string) => {
    const input = textarea()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.setSelectionRange(value.length, value.length)
    await act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const button = (name: string) => [...host.querySelectorAll('button')].find((item) =>
    item.getAttribute('aria-label') === name || item.textContent?.includes(name))

  try {
    await act(() => root.render(<Harness />))
    await type('/pd')
    const option = button('处理 PDF')
    expect(option).toBeDefined()
    await act(() => option!.click())
    expect(textarea().value).toBe('/pdf ')

    await type('/pdf 总结一下')
    await act(() => button('发送')!.click())
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]![0]).toBe('总结一下')
    expect(onSend.mock.calls[0]![1]).toEqual([{ type: 'skill', name: 'pdf', path: '/skills/pdf/SKILL.md' }])

    // 手动删掉标记后不再随消息发送技能。
    await type('再总结 /pd')
    await act(() => button('处理 PDF')!.click())
    expect(textarea().value).toBe('再总结 /pdf ')
    await type('再总结 ')
    await act(() => button('发送')!.click())
    expect(onSend.mock.calls[1]![0]).toBe('再总结 ')
    expect(onSend.mock.calls[1]![1]).toEqual([])
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('运行中点按发送键按设置发送，不能引导时显示排队', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useMobilePreferences.getState()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onSend = vi.fn<(text: string, attachments: UserInput[], mode: SendMode) => Promise<boolean>>().mockResolvedValue(false)
  const render = (text: string, canSteer = true) => act(() => root.render(
    <Composer draftKey="running-test" text={text} onChangeText={() => {}} onSend={onSend} onInterrupt={() => {}}
      running sending={false} annotations={[]} onUpdateAnnotation={() => {}} onRemoveAnnotation={() => {}}
      quoteDraft={null} onConfirmQuote={() => {}} onCancelQuote={() => {}} canSteer={canSteer} />,
  ))
  const send = () => host.querySelector<HTMLButtonElement>('.qn-send-button')!
  try {
    await render('补充')
    expect(send().getAttribute('aria-label')).toBe('引导')
    await act(() => send().click())
    await render('补充', false)
    expect(send().getAttribute('aria-label')).toBe('排队')
    await render('/review')
    expect(send().getAttribute('aria-label')).toBe('排队')
    await act(() => useMobilePreferences.setState({ runningSend: 'interrupt' }))
    await render('补充')
    expect(send().getAttribute('aria-label')).toBe('打断后发送')
    await act(() => send().click())
    expect(onSend.mock.calls.map((call) => call[2])).toEqual(['steer', 'immediate'])
  } finally {
    await act(() => root.unmount())
    useMobilePreferences.setState(initial)
    host.remove()
    vi.unstubAllGlobals()
  }
})
