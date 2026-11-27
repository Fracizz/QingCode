// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { subscribeOpen } from '../features/workspace/openers'
import { pendingSendKey, useCodex } from '../store/codex'
import { SendQueue, newThreadActions } from './SendQueue'

vi.mock('./ui', () => ({
  IconButton: ({ label, size: _size, tooltip: _tooltip, ...props }: ComponentProps<'button'> & {
    label: string
    size?: string
    tooltip?: boolean
  }) => <button type="button" aria-label={label} {...props} />,
}))

it('排队消息用带标签的缩略图打开图片预览，用图标查看附件和技能', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const chat = { targetId: 'remote', agent: 'codex', threadId: 'thread' } as const
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII='
  const notePath = '/tmp/note#1.txt'
  const openFile = vi.fn()
  const stopListening = subscribeOpen(openFile)
  const remove = vi.fn()
  const previous = useCodex.getState()
  useCodex.setState({ currentTargetId: chat.targetId, currentCwd: '/work', removePendingSend: remove, pendingSends: {
    [pendingSendKey(chat)]: [{ id: 1, text: '排队正文', overrides: {}, input: [
      { type: 'text', text: '排队正文', text_elements: [] },
      { type: 'image', url: image },
      { type: 'mention', name: 'note#1.txt', path: notePath },
      { type: 'skill', name: 'review', path: '.codex/skills/review/SKILL.md' },
    ] }, { id: 2, text: '', overrides: {}, input: [{ type: 'image', url: image }] }],
  } })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(() => root.render(<SendQueue {...chat} running />))
    const [row, imageOnly] = Array.from(host.querySelectorAll('li'))
    const thumbnail = row!.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
    const dialog = row!.querySelector('dialog')!
    const showModal = vi.fn()
    const close = vi.fn()
    Object.assign(dialog, { showModal, close })
    expect(row?.textContent).toContain('排队正文')
    expect(thumbnail.textContent).toBe('图片 1')
    expect(thumbnail.querySelector('img')?.getAttribute('src')).toBe(image)
    expect(imageOnly?.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull()
    expect(imageOnly?.textContent).not.toContain('附件或技能')

    thumbnail.click()
    expect(showModal).toHaveBeenCalledOnce()
    dialog.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')!.click()
    expect(close).toHaveBeenCalledOnce()
    row!.querySelector<HTMLButtonElement>('[aria-label="打开附件 note#1.txt"]')!.click()
    row!.querySelector<HTMLButtonElement>('[aria-label="查看技能 review"]')!.click()
    expect(openFile.mock.calls).toEqual([
      [{ kind: 'file', targetId: chat.targetId, path: notePath }],
      [{ kind: 'file', targetId: chat.targetId, path: '/work/.codex/skills/review/SKILL.md' }],
    ])
    expect(remove).not.toHaveBeenCalled()
    row!.querySelector<HTMLButtonElement>('[aria-label="移除排队消息"]')!.click()
    expect(remove).toHaveBeenCalledExactlyOnceWith(chat, 1)
  } finally {
    await act(() => root.unmount())
    host.remove()
    stopListening()
    useCodex.setState(previous)
    vi.unstubAllGlobals()
  }
})

it('三端都能分支继续，Claude 与 pi 另保留侧边栏开始', () => {
  expect(newThreadActions('codex').map(({ mode }) => mode)).toEqual(['start', 'continue'])
  expect(newThreadActions('claude').map(({ mode }) => mode)).toEqual(['start', 'continue', 'side'])
  expect(newThreadActions('pi').map(({ mode }) => mode)).toEqual(['start', 'continue', 'side'])
})
