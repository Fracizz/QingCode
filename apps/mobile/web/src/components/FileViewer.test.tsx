// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useApp, type ViewerState } from '../store'
import { FileViewer } from './FileViewer'

const content = '# 标题\n\n正文 **加粗**\n'
const viewer = (path: string, line: number | null = null): ViewerState => ({
  mode: 'file', targetId: 't', path, cwd: '/repo', line, loading: false, loadingMore: false, error: null,
  file: { path, content, encoding: 'utf8', size: content.length, offset: 0, length: content.length, truncated: false, binary: false },
  diff: null, diffSource: null, diffTruncated: false, notice: null,
})

afterEach(() => {
  useApp.setState({ viewer: null })
  vi.unstubAllGlobals()
})

async function mount(state: ViewerState) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom 没有 scrollIntoView，行号跳转会调用它。
  Element.prototype.scrollIntoView ??= vi.fn()
  const host = document.createElement('div')
  const root = createRoot(host)
  useApp.setState({ viewer: state })
  await act(() => root.render(<FileViewer />))
  return { host, root }
}

it('Markdown 文件默认显示预览，可切到源码再切回', async () => {
  const { host, root } = await mount(viewer('/repo/README.md'))
  try {
    expect(host.querySelector('.qn-markdown-file h1')?.textContent).toBe('标题')
    expect(host.querySelector('.qn-code')).toBeNull()
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="查看源码"]')!
    await act(() => toggle.click())
    expect(host.querySelector('.qn-markdown-file')).toBeNull()
    expect(host.querySelector('.qn-code')?.textContent).toContain('# 标题')
    await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Markdown 预览"]')!.click())
    expect(host.querySelector('.qn-markdown-file strong')?.textContent).toBe('加粗')
  } finally {
    await act(() => root.unmount())
  }
})

it('带行号打开 Markdown 时默认源码，非 Markdown 文件没有切换按钮', async () => {
  const { host, root } = await mount(viewer('/repo/README.md', 3))
  try {
    expect(host.querySelector('.qn-code-row-hit')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Markdown 预览"]')).not.toBeNull()
    await act(() => useApp.setState({ viewer: viewer('/repo/a.ts') }))
    expect(host.querySelector('.qn-markdown-file')).toBeNull()
    expect(host.querySelector('button[aria-label="查看源码"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
  }
})
