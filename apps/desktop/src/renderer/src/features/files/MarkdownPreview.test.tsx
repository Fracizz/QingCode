// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'
import { copyText } from '../../lib/clipboard'

vi.mock('../../lib/cn', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }))
vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('radix-ui', () => {
  const childrenOnly = ({ children }: { children: ReactNode }) => children
  return { ContextMenu: { Root: childrenOnly, Trigger: childrenOnly } }
})
vi.mock('../../components/primitives', () => ({
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, disabled, onSelect }: { children: ReactNode; disabled?: boolean; onSelect: () => void }) =>
    <button disabled={disabled} onClick={onSelect}>{children}</button>,
  ContextMenuSeparator: () => <hr />,
}))

it('Markdown 目录在当前预览里跳到中文和重复标题，外链仍使用新窗口', async () => {
  const host = document.createElement('div')
  const other = document.createElement('h2')
  other.id = '安装-步骤-1'
  other.scrollIntoView = vi.fn()
  document.body.append(other, host)
  const root = createRoot(host)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    const markdown = [
      '[跳转](#%E5%AE%89%E8%A3%85-%E6%AD%A5%E9%AA%A4-1) · [外部](https://example.com)',
      '## 安装 **步骤**',
      '## 安装 步骤',
    ].join('\n\n')
    await act(() => root.render(<MarkdownPreview content={markdown} targetId="local" cwd="/project" onViewSource={vi.fn()} />))
    const headings = [...host.querySelectorAll('h2')]
    expect(headings.map((heading) => heading.id)).toEqual(['安装-步骤', '安装-步骤-1'])
    const destination = headings[1]!
    destination.scrollIntoView = vi.fn()
    const [anchor, external] = [...host.querySelectorAll('a')]
    expect(anchor?.target).toBe('')
    expect(external?.target).toBe('_blank')
    expect(anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false)
    expect(destination.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(document.activeElement).toBe(destination)
    expect(other.scrollIntoView).not.toHaveBeenCalled()
  } finally {
    await act(() => root.unmount())
    host.remove()
    other.remove()
    vi.unstubAllGlobals()
  }
})

it('右键操作使用预览内的选区、链接和当前文档', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onViewSource = vi.fn()
  const markdown = '说明 [**示例**](./example.md)'
  const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)
  const rightClick = (element: Element) => act(() => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    await act(() => root.render(<MarkdownPreview content={markdown} targetId="local" cwd="/project" onViewSource={onViewSource} />))
    const linkText = host.querySelector('strong')!
    window.getSelection()!.selectAllChildren(linkText)
    await rightClick(linkText)
    window.getSelection()!.removeAllRanges()
    button('复制选中文字')!.click()
    expect(copyText).toHaveBeenLastCalledWith('示例')
    button('复制链接地址')!.click()
    expect(copyText).toHaveBeenLastCalledWith('./example.md')
    await rightClick(host.querySelector('p')!)
    expect(button('复制选中文字')!.disabled).toBe(true)
    expect(button('复制链接地址')).toBeUndefined()
    button('复制 Markdown 源码')!.click()
    expect(copyText).toHaveBeenLastCalledWith(markdown)
    button('查看源码')!.click()
    expect(onViewSource).toHaveBeenCalledOnce()
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
