// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MarkdownPreview from './MarkdownPreview'

const mocks = vi.hoisted(() => ({
  authorizePaths: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
  isTauri: vi.fn(() => true),
  openFile: vi.fn(),
  openUrl: vi.fn(),
  pushToast: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convertFileSrc }))
vi.mock('../lib/pathAllowlist', () => ({ authorizePaths: mocks.authorizePaths }))
vi.mock('../lib/tauri', () => ({ isTauri: mocks.isTauri }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }))
vi.mock('../lib/copyFileActions', () => ({
  COPY_REFERENCE_FOCUS_ATTR: 'data-qingcode-copy-reference-path',
  COPY_REFERENCE_LINE_ATTR: 'data-qingcode-copy-reference-line',
}))
vi.mock('../store/editorStore', () => ({
  useEditorStore: { getState: () => ({ openFile: mocks.openFile }) },
}))
vi.mock('../store/projectStore', () => ({
  useProjectStore: { getState: () => ({
    projects: [{ id: 'p1', name: 'nem-panel', path: 'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel' }],
    pushToast: mocks.pushToast,
  }) },
}))

describe('MarkdownPreview local images', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authorizePaths.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
    mocks.openFile.mockResolvedValue(undefined)
    mocks.openUrl.mockResolvedValue(undefined)
  })

  it('authorizes and loads a relative image from the Markdown file directory', async () => {
    render(
      <MarkdownPreview
        content="![发布配置总览](新平台CICD发布配置说明图/01-发布配置总览.png)"
        filePath="D:\\Download\\新平台CICD发布配置使用说明.md"
      />,
    )

    const path = 'D:/Download/新平台CICD发布配置说明图/01-发布配置总览.png'
    await waitFor(() => expect(mocks.authorizePaths).toHaveBeenCalledWith([path]))
    expect(mocks.convertFileSrc).toHaveBeenCalledWith(path)
    expect(screen.getByRole('img', { name: '发布配置总览' })).toHaveAttribute(
      'src',
      `asset://localhost/${encodeURIComponent(path)}`,
    )
  })

  it('leaves remote images unchanged', () => {
    render(
      <MarkdownPreview
        content="![remote](https://example.com/image.png)"
        filePath="D:\\Download\\README.md"
      />,
    )

    expect(screen.getByRole('img', { name: 'remote' })).toHaveAttribute(
      'src',
      'https://example.com/image.png',
    )
    expect(mocks.authorizePaths).not.toHaveBeenCalled()
  })

  it.each([
    'docs/internal/technical/internal-test-accounts.md',
    '/docs/internal/technical/internal-test-accounts.md',
  ])('opens the SSH Markdown link %s inside the editor and exposes its copy target', async source => {
    render(<MarkdownPreview
      content={`[内部测试环境账号](${source})`}
      filePath="ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/CLAUDE.md"
    />)
    const link = screen.getByRole('link', { name: '内部测试环境账号' })
    const target = 'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/docs/internal/technical/internal-test-accounts.md'
    expect(link).toHaveAttribute('href', target)
    expect(link).toHaveAttribute('data-qingcode-copy-reference-path', target)
    fireEvent.click(link)
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith(target, undefined))
  })

  it('does not open links that escape registered projects', () => {
    render(<MarkdownPreview
      content="[outside](../private.md)"
      filePath="ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/CLAUDE.md"
    />)
    fireEvent.click(screen.getByRole('link', { name: 'outside' }))
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('error', expect.any(String))
  })

  it('opens a linked file at its line and exposes that line for Alt+C', async () => {
    render(<MarkdownPreview
      content="[source](docs/source.ts#L21)"
      filePath="ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/CLAUDE.md"
    />)
    const link = screen.getByRole('link', { name: 'source' })
    const target = 'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/docs/source.ts'
    expect(link).toHaveAttribute('data-qingcode-copy-reference-line', '21')
    fireEvent.click(link)
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith(target, 21))
  })
})
