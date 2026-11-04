// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer'
import { IMAGE_MAX_BYTES } from '../lib/imageFiles'
import type { EditorTab } from '../types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => invoke(...args),
}))

function imageTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: 'tab-1',
    path: '/tmp/shot.png',
    name: 'shot.png',
    dirty: false,
    viewMode: 'image',
    fileSize: 2048,
    ...overrides,
  } as EditorTab
}

describe('ImageViewer', () => {
  beforeEach(() => {
    invoke.mockReset()
    // jsdom 未实现 objectURL，用桩替换并跟踪 revoke 生命周期。
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:mock-url')
        static revokeObjectURL = vi.fn()
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the image after raw bytes load and requests read_image_file', async () => {
    invoke.mockResolvedValue(new ArrayBuffer(8))
    render(<ImageViewer tab={imageTab()} />)

    // 容器 div 也带 role="img"（aria-label=文件名）；位图断言要落在真正的 <img> 上。
    await waitFor(() => {
      const bitmap = screen.getByRole('img').querySelector('img')
      expect(bitmap).not.toBeNull()
      expect(bitmap).toHaveAttribute('src', 'blob:mock-url')
    })
    expect(invoke).toHaveBeenCalledWith('读取图片', 'read_image_file', { path: '/tmp/shot.png' })
    expect(screen.queryByText('加载图片失败')).toBeNull()
  })

  it('shows the error state with a retry button when the read fails', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    render(<ImageViewer tab={imageTab()} />)

    await waitFor(() => {
      expect(screen.getByText('加载图片失败')).toBeDefined()
    })
    expect(screen.queryByRole('img')).toBeNull()

    invoke.mockResolvedValue(new ArrayBuffer(8))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(screen.getByRole('img').querySelector('img')).not.toBeNull()
    })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('rejects oversized images locally without invoking the backend', async () => {
    render(<ImageViewer tab={imageTab({ fileSize: IMAGE_MAX_BYTES + 1 })} />)

    await waitFor(() => {
      expect(screen.getByText(/图片过大/)).toBeDefined()
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
