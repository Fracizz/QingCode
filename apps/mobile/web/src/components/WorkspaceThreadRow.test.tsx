// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useApp } from '../store'
import { ARCHIVE_ACTION_WIDTH } from '../threadSwipe'
import type { WorkspaceThread } from '../workspace'
import { WorkspaceThreadRow } from './WorkspaceHome'

it('左滑后第一次轻点归档立即提交，滚动和补发的 click 不会重复提交', async () => {
  const app = useApp.getState()
  const thread: WorkspaceThread = {
    id: 'thread', title: '历史会话', preview: '', cwd: '/project', updatedAt: 0,
    targetId: 'local', projectId: 'project', agent: 'codex',
  }
  let finishArchive!: () => void
  const reply = new Promise<void>((resolve) => { finishArchive = resolve })
  const archiveConversation = vi.fn().mockReturnValueOnce(reply).mockResolvedValue(undefined)
  const onOpen = vi.fn()
  useApp.setState({ activeId: 'desktop', archiveConversation })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const hitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

  function touch(button: HTMLButtonElement, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
    Object.assign(event, { pointerType: 'touch', pointerId: 1, isPrimary: true })
    button.dispatchEvent(event)
  }

  try {
    await act(() => root.render(<WorkspaceThreadRow thread={thread} onOpen={onOpen} />))
    const [row, archive] = host.querySelectorAll('button')
    if (!row || !archive) throw new Error('缺少会话或归档按钮')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => archive })

    await act(() => {
      row.focus()
      touch(row, 'pointerdown', 190, 30)
      touch(row, 'pointermove', 100, 30)
      touch(row, 'pointerup', 100, 30)
    })
    expect(row.style.transform).toBe(`translateX(-${ARCHIVE_ACTION_WIDTH}px)`)

    await act(() => {
      touch(archive, 'pointerdown', 190, 30)
      touch(archive, 'pointermove', 190, 55)
      touch(archive, 'pointerup', 190, 30)
    })
    expect(archiveConversation).toHaveBeenCalledTimes(0)

    await act(() => {
      touch(archive, 'pointerdown', 190, 30)
      row.blur()
    })
    expect(row.style.transform).toBe(`translateX(-${ARCHIVE_ACTION_WIDTH}px)`)
    await act(() => touch(archive, 'pointerup', 190, 30))
    expect(archiveConversation).toHaveBeenCalledExactlyOnceWith('local', thread)
    expect(archive.textContent).toBe('归档中…')
    expect(onOpen).toHaveBeenCalledTimes(0)

    await act(async () => finishArchive())
    await act(() => {
      archive.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    expect(archiveConversation).toHaveBeenCalledTimes(1)

    await act(() => {
      archive.focus()
      archive.click()
    })
    expect(archiveConversation).toHaveBeenCalledTimes(2)
  } finally {
    finishArchive()
    await act(() => root.unmount())
    host.remove()
    if (hitTest) Object.defineProperty(document, 'elementFromPoint', hitTest)
    else Reflect.deleteProperty(document, 'elementFromPoint')
    useApp.setState({ activeId: app.activeId, archiveConversation: app.archiveConversation })
    vi.unstubAllGlobals()
  }
})
