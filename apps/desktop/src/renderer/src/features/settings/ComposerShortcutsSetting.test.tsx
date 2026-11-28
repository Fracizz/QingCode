// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/primitives'
import { useComposerShortcuts } from '../composer/shortcuts'
import { ComposerShortcutsSetting } from './ComposerShortcutsSetting'

const STORAGE_KEY = 'qn-composer-shortcuts'

it('可添加、编辑、拖动排序和删除快捷标签，重载后保留顺序和多行文字', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const previous = useComposerShortcuts.getState()
  const stored = localStorage.getItem(STORAGE_KEY)
  useComposerShortcuts.setState({ shortcuts: [
    { id: 'one', name: '继续', text: '继续', send: false },
    { id: 'two', name: '分析', text: '先分析', send: true },
  ] })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)!
  const names = () => useComposerShortcuts.getState().shortcuts.map((item) => item.name)
  const change = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }

  try {
    await act(() => root.render(<TooltipProvider><ComposerShortcutsSetting /></TooltipProvider>))
    await act(() => button('添加').click())
    const text = '用 review 技能检查当前改动\n列出结论'
    const form = document.querySelector('form')!
    expect(button('保存').disabled).toBe(true)
    expect(form.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false')
    await act(() => {
      change(form.querySelector('input')!, '检查')
      change(form.querySelector('textarea')!, text)
    })
    await act(() => button('保存').click())
    expect(names()).toEqual(['继续', '分析', '检查'])

    await act(() => button('编辑快捷标签 检查').click())
    const editor = document.querySelector('form')!
    expect(editor.querySelector('textarea')?.value).toBe(text)
    await act(() => (editor.querySelector('[role="checkbox"]') as HTMLButtonElement).click())
    await act(() => button('保存').click())
    expect(useComposerShortcuts.getState().shortcuts[2]).toMatchObject({ text, send: true })

    const data = new Map<string, string>()
    const transfer = {
      get types() { return [...data.keys()] },
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type),
    }
    const drag = (element: HTMLElement, type: string, clientY = 0) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      element.dispatchEvent(event)
      return event
    }
    const handle = button('拖动排序 检查')
    const first = button('拖动排序 继续').closest('li')!
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40))
    await act(() => { drag(handle, 'dragstart') })
    await act(() => { expect(drag(first, 'dragover', 5).defaultPrevented).toBe(true) })
    await act(() => { drag(first, 'drop', 5) })
    expect(names()).toEqual(['检查', '继续', '分析'])

    await act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', key: 'ArrowDown', altKey: true, bubbles: true }))
    })
    expect(names()).toEqual(['继续', '检查', '分析'])
    await act(() => button('删除快捷标签 分析').click())
    expect(names()).toEqual(['继续', '检查'])

    vi.resetModules()
    const reloaded = await import('../composer/shortcuts')
    expect(reloaded.useComposerShortcuts.getState().shortcuts).toEqual(useComposerShortcuts.getState().shortcuts)
  } finally {
    await act(() => root.unmount())
    host.remove()
    useComposerShortcuts.setState(previous, true)
    if (stored === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, stored)
    vi.unstubAllGlobals()
  }
})
