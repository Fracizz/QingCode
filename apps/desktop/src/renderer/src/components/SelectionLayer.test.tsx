// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SelectionLayer } from './SelectionLayer'

vi.mock('./ui', () => ({
  IconButton: ({ label, ...props }: ComponentProps<'button'> & { label: string }) =>
    <button aria-label={label} {...props} />,
}))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let textTop: number
const onAdd = vi.fn()

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  textTop = 100
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(30, textTop, 150, 18)],
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onAdd.mockClear()
  await act(() => root.render(
    <SelectionLayer onAdd={onAdd}>
      <p data-chat-item="test" style={{ overflowX: 'visible', overflowY: 'visible' }}>要引用的一行文字</p>
    </SelectionLayer>,
  ))
  Object.defineProperties(host.firstElementChild!, {
    clientWidth: { value: 400 },
    clientHeight: { value: 260 },
  })
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  document.getSelection()?.removeAllRanges()
  Reflect.deleteProperty(Range.prototype, 'getClientRects')
  vi.unstubAllGlobals()
})

function toolbar(): HTMLElement | null {
  return host.querySelector('[data-qn-selection]')
}

async function selectMessage() {
  const paragraph = host.querySelector('p')!
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  document.getSelection()!.addRange(range)
  await act(() => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  expect(toolbar()).not.toBeNull()
  return paragraph
}

const nextFrame = () => act(async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
})

it('浏览器选区取消后收起工具条', async () => {
  await selectMessage()
  document.getSelection()!.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  await nextFrame()
  expect(toolbar()).toBeNull()
})

it('正文移动时更新工具条位置，正文移出可视范围后关闭工具条', async () => {
  const paragraph = await selectMessage()
  const originalTop = toolbar()?.style.top
  textTop += 30
  paragraph.style.marginTop = '30px'
  await nextFrame()
  expect(toolbar()?.style.top).not.toBe(originalTop)
  textTop = -50
  host.firstElementChild!.dispatchEvent(new Event('scroll'))
  await nextFrame()
  expect(toolbar()).toBeNull()
})

it('评论输入时保留有效选区，正文被移除后关闭工具条', async () => {
  const paragraph = await selectMessage()
  await act(() => toolbar()!.querySelector('button')!.click())
  document.dispatchEvent(new Event('selectionchange'))
  await nextFrame()
  expect(document.getSelection()?.isCollapsed).toBe(true)
  expect(toolbar()?.querySelector('input')).not.toBeNull()
  paragraph.remove()
  await nextFrame()
  expect(toolbar()).toBeNull()
  expect(onAdd).not.toHaveBeenCalled()
})

it('点击对话区外的空白会关闭评论工具条', async () => {
  await selectMessage()
  await act(() => toolbar()!.querySelector('button')!.click())
  await act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  expect(toolbar()).toBeNull()
})
