// @vitest-environment jsdom
import type { UserInput } from '@qn/codex-client'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createGateway, GatewayClient, setGateway } from '../client'
import type { DraftImage } from '../composerLogic'
import { useMobilePreferences } from '../mobilePreferences'
import type { SendMode } from '../store'
import { Composer } from './Composer'

const skill = { name: 'pdf', description: '处理 PDF', scope: '用户', path: '/skills/pdf/SKILL.md' }

it('只有空草稿显示建议，点按后填入可编辑的消息', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onSend = vi.fn().mockResolvedValue(true)
  function Harness() {
    const [text, onChangeText] = useState('我的草稿')
    return <Composer draftKey="prompt-suggestion-test" agent="claude" text={text} onChangeText={onChangeText}
      promptSuggestion="继续跑测试" onSend={onSend} onInterrupt={vi.fn()} running={false} sending={false}
      annotations={[]} onUpdateAnnotation={vi.fn()} onRemoveAnnotation={vi.fn()}
      quoteDraft={null} onConfirmQuote={vi.fn()} onCancelQuote={vi.fn()} canSteer={false} />
  }
  const option = () => host.querySelector<HTMLButtonElement>('[aria-label="填入建议：继续跑测试"]')
  try {
    await act(() => root.render(<Harness />))
    const textarea = host.querySelector('textarea')!
    expect(textarea.value).toBe('我的草稿')
    expect(option()).toBeNull()
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(() => option()!.click())
    expect(textarea.value).toBe('继续跑测试')
    expect(document.activeElement).toBe(textarea)
    expect(option()).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

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

    // 手动敲出完整技能名：输入框里上色，发送时同样按 skill 输入。
    await type('/pdf all')
    expect(host.querySelector('.qn-composer-skill')?.textContent).toBe('/pdf')
    expect(host.querySelector('.qn-composer-mirror')?.textContent).toBe('/pdf all')
    await act(() => button('发送')!.click())
    expect(onSend.mock.calls[2]![0]).toBe('all')
    expect(onSend.mock.calls[2]![1]).toEqual([{ type: 'skill', name: 'pdf', path: '/skills/pdf/SKILL.md' }])

    await type('/pdfx')
    expect(host.querySelector('.qn-composer-mirror')).toBeNull()
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
    // 手机默认排队，引导需用户长按选择或在设置里改。
    await render('补充')
    expect(send().getAttribute('aria-label')).toBe('排队')
    await act(() => useMobilePreferences.setState({ runningSend: 'steer' }))
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

it('选图在光标处插入可预览的省略标签，移除与发送都对应原图', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const gateway = createGateway() as GatewayClient
  setGateway(gateway)
  const name = '12345678-很长的截图文件名称-abcdefg.png'
  const first = { name, mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' }
  const second = { name: '短图.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AQ==' }
  const device = vi.spyOn(gateway, 'device').mockResolvedValue({ images: [first, second], skipped: 0 })
  const dialogPrototype = HTMLDialogElement.prototype
  const dialogMethods = Object.getOwnPropertyDescriptors(dialogPrototype)
  Object.defineProperties(dialogPrototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const onSend = vi.fn<(text: string, attachments: UserInput[], mode: SendMode) => Promise<boolean>>().mockResolvedValue(false)
  function Harness() {
    const [text, setText] = useState('看这里')
    const [images, setImages] = useState<readonly DraftImage[]>([])
    return <Composer draftKey="images-test" text={text} images={images} onChangeText={(next, photos) => {
      setText(next)
      if (photos) setImages(photos)
    }} onSend={onSend} onInterrupt={() => {}} running={false} sending={false} annotations={[]}
      onUpdateAnnotation={() => {}} onRemoveAnnotation={() => {}} quoteDraft={null} onConfirmQuote={() => {}}
      onCancelQuote={() => {}} canSteer={false} />
  }

  try {
    await act(() => root.render(<Harness />))
    const area = host.querySelector('textarea')!
    await act(async () => {
      area.setSelectionRange(1, 1)
      host.querySelector<HTMLButtonElement>('[aria-label="添加图片"]')!.click()
    })
    const label = host.querySelector<HTMLElement>('.qn-composer-attachment')!
    expect(label.textContent).toBe('[12345678…abcdefg.png]')
    expect(area.value).toBe('看 [12345678…abcdefg.png] [短图.png] 这里')
    expect(area.selectionStart).toBe(area.value.indexOf('这里'))
    await act(() => label.click())
    const dialog = host.querySelector('dialog[open]')!
    expect(dialog.getAttribute('aria-label')).toBe(name)
    expect(dialog.querySelector('img')?.src).toBe(first.dataUrl)
    const navigate = (direction: string) => dialog.querySelector<HTMLButtonElement>(`[aria-label="${direction}张图片"]`)!
    const position = () => dialog.querySelector('[aria-label="图片位置"]')?.textContent
    const swipeLeft = () => {
      const stage = dialog.querySelector('.qn-image-stage')!
      const touch = (clientX: number) => ({ identifier: 1, clientX, clientY: 40 })
      stage.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [touch(150)] }))
      stage.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true, cancelable: true }), {
        touches: [], changedTouches: [touch(50)],
      }))
    }
    expect(position()).toBe('1 / 2')
    expect(navigate('上一').disabled).toBe(true)
    await act(() => dialog.querySelector('img')!.dispatchEvent(new Event('load')))
    await act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="放大"]')!.click())
    await act(swipeLeft)
    expect(position()).toBe('1 / 2')
    await act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="适应窗口"]')!.click())
    await act(swipeLeft)
    expect(position()).toBe('2 / 2')
    expect(dialog.querySelector('img')?.src).toBe(second.dataUrl)
    expect(navigate('下一').disabled).toBe(true)
    await act(() => navigate('上一').click())
    expect(dialog.querySelector('img')?.src).toBe(first.dataUrl)
    await act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click())

    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="移除 短图.png"]')!.click())
    expect(area.value).toBe('看 [12345678…abcdefg.png] 这里')
    await act(() => host.querySelector<HTMLButtonElement>('.qn-image-thumbnail')!.click())
    expect(host.querySelector('dialog[open] [aria-label="切换图片"]')).toBeNull()
    await act(() => host.querySelector<HTMLButtonElement>('dialog[open] [aria-label="关闭"]')!.click())
    await act(() => host.querySelector<HTMLButtonElement>('.qn-send-button')!.click())
    expect(onSend).toHaveBeenCalledWith(`看 [${name}] 这里\n\n附图编号（按本条消息中图片的先后顺序）：\n1. [${name}]`,
      [{ type: 'image', url: first.dataUrl }], 'queue')
    expect(host.querySelectorAll('.qn-composer-attachment')).toHaveLength(1)
  } finally {
    await act(() => root.unmount())
    host.remove()
    device.mockRestore()
    for (const name of ['showModal', 'close'] as const) {
      if (dialogMethods[name]) Object.defineProperty(dialogPrototype, name, dialogMethods[name])
      else Reflect.deleteProperty(dialogPrototype, name)
    }
    setGateway(null)
    vi.unstubAllGlobals()
  }
})
