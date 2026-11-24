// @vitest-environment jsdom

import { useRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MarkdownPreviewFind from './MarkdownPreviewFind'

function Harness({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div>
      <div ref={ref}>
        <p>是高性能服务器管理面板</p>
        <p>服务器监控</p>
      </div>
      <MarkdownPreviewFind previewRef={ref} content="x" seed="" focusToken={1} onClose={onClose} />
    </div>
  )
}

describe('MarkdownPreviewFind', () => {
  it('统计预览匹配、Enter 切换并 Esc 关闭', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const input = screen.getByRole('textbox', { name: '查找' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '服务器' } })
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy())
    fireEvent.change(input, { target: { value: '不存在' } })
    await waitFor(() => expect(screen.getByText('无结果')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
