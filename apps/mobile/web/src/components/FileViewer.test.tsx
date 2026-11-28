// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as client from '../client'
import { useApp, type ViewerState } from '../store'
import { clearToasts, useToasts } from '../toast'
import { FileViewer } from './FileViewer'

const content = '# 标题\n\n正文 **加粗**\n'
const viewer = (path: string, line: number | null = null): ViewerState => ({
  mode: 'file', targetId: 't', path, cwd: '/repo', line, loading: false, loadingMore: false, error: null,
  file: { path, content, encoding: 'utf8', size: content.length, offset: 0, length: content.length, truncated: false, binary: false },
  diff: null, diffSource: null, diffTruncated: false, notice: null,
})

afterEach(() => {
  useApp.setState({ viewer: null, projects: [], activeId: null, connections: [] })
  clearToasts()
  vi.useRealTimers()
  vi.restoreAllMocks()
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

it('截断的二进制文件从预览启动完整下载，关闭预览后仍提示保存结果', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('QnNative', { postMessage: vi.fn() })
  const address = { host: 'pc.example', port: 38500, fp: 'a'.repeat(64), token: 'test-token' }
  const project = { id: 'p', targetId: 't', name: 'repo', path: '/D:/Code/Repo', lastOpenedAt: 0 }
  useApp.setState({
    activeId: 'pc',
    connections: [{ ...address, id: 'pc', name: 'PC', desktopName: 'PC', createdAt: 0 }],
    projects: [project],
  })
  const path = 'dist/app.apk'
  const size = 800_000
  const job = { id: 'apk', path, name: 'app.apk', size, written: 0, state: 'running', auto: true }
  const callDevice = vi.spyOn(client, 'callDevice').mockResolvedValueOnce(job)
    .mockResolvedValueOnce({ ...job, state: 'done', written: size })
  const state = viewer('d:\\code\\Repo\\dist\\app.apk')
  const { host, root } = await mount({ ...state, file: { ...state.file!, content: '', binary: true, truncated: true, size, length: 0 } })
  try {
    expect(host.textContent).toContain('已截断')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '下载')!
    await act(() => button.click())
    expect(callDevice).toHaveBeenCalledWith('download.start', {
      ...address, projectId: 'p', targetId: 't', path, name: 'app.apk', size,
    }, 300_000)

    await act(() => useApp.getState().closeViewer())
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(callDevice).toHaveBeenCalledWith('download.status', { id: 'apk' })
    expect(useToasts.getState().items.map((item) => item.message)).toContain('已下载 app.apk，保存在 下载/QingCode')
  } finally {
    await act(() => root.unmount())
  }
})

it('下载入口只匹配同一目标上的项目目录', async () => {
  vi.stubGlobal('QnNative', { postMessage: vi.fn() })
  useApp.setState({
    activeId: 'pc',
    projects: [
      { id: 'p1', targetId: 't', name: 'repo', path: '/repo', lastOpenedAt: 0 },
      { id: 'p2', targetId: 'other', name: 'repo2', path: '/repo2', lastOpenedAt: 0 },
    ],
  })
  const { host, root } = await mount(viewer('/repo/releases/app.apk'))
  try {
    expect(host.textContent).toContain('下载')
    await act(() => useApp.setState({ viewer: viewer('/repo2/app.apk') }))
    expect(host.textContent).not.toContain('下载')
  } finally {
    await act(() => root.unmount())
  }
})
