// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MarkdownPreview from './MarkdownPreview'

const mocks = vi.hoisted(() => ({
  authorizePaths: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convertFileSrc }))
vi.mock('../lib/pathAllowlist', () => ({ authorizePaths: mocks.authorizePaths }))
vi.mock('../lib/tauri', () => ({ isTauri: mocks.isTauri }))

describe('MarkdownPreview local images', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authorizePaths.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
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
})
