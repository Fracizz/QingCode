// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'

vi.mock('../../lib/cn', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }))

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
    await act(() => root.render(<MarkdownPreview content={markdown} targetId="local" cwd="/project" />))
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
