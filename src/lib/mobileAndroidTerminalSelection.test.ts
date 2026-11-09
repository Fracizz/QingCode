// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalSelection } from '../../mobile/android/web/terminalSelection.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks() })

function fixture({ canQuote = () => false, text = '' }: { canQuote?: () => boolean; text?: string } = {}) {
  const container = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  container.append(screen)
  document.body.append(container)
  const rect = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 } as DOMRect
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect)
  let selected: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  const subscribe = () => ({ dispose: vi.fn() })
  const select = vi.fn((col: number, row: number, length: number) => {
    const end = row * 20 + col + length
    selected = { start: { x: col, y: row }, end: { x: end % 20, y: Math.floor(end / 20) } }
  })
  const term = {
    element: container, cols: 20, rows: 5,
    buffer: { active: { type: 'normal', viewportY: 0, length: 5,
      getLine: () => ({ getCell: (col: number) => ({ getChars: () => 'alpha-beta gamma    '[col] ?? '', getWidth: () => 1 }) }),
    } },
    select, getSelectionPosition: () => selected, clearSelection: () => { selected = undefined },
    getSelection: () => text, selectAll: vi.fn(), scrollLines: vi.fn(), paste: vi.fn(),
    onScroll: subscribe, onRender: subscribe, onResize: subscribe,
  }
  const copyText = vi.fn(async (_text: string) => {})
  const selection = attachTerminalSelection({ term, container, copyText, canQuote })
  disposers.push(() => selection.dispose())
  const quoteButton = () => [...container.querySelectorAll<HTMLButtonElement>('.terminal-selection-tools button')]
    .find(button => button.textContent === '添加到对话')!
  return { selection, select, term, quoteButton, copyText, container }
}

describe('Android virtual mouse selection', () => {
  it('starts with the word under the pointer then extends directly across rows', () => {
    const { selection, select } = fixture()
    selection.drag('down', { x: 25, y: 5 })
    expect(select).toHaveBeenLastCalledWith(0, 0, 10)
    selection.drag('move', { x: 145, y: 35 })
    expect(select).toHaveBeenLastCalledWith(0, 0, 35)
    selection.drag('up', { x: 155, y: 55 })
    expect(select).toHaveBeenLastCalledWith(0, 0, 56)
    expect(selection.isActive()).toBe(true)
  })

  it('stops extending after the virtual button is released', () => {
    const { selection, select } = fixture()
    selection.drag('down', { x: 25, y: 5 })
    selection.drag('up', { x: 125, y: 5 })
    const calls = select.mock.calls.length
    selection.drag('move', { x: 180, y: 60 })
    expect(select).toHaveBeenCalledTimes(calls)
  })

  it('clears the drag anchor on cancellation or disposal', () => {
    const { selection, select } = fixture()
    selection.drag('down', { x: 25, y: 5 })
    selection.close()
    const calls = select.mock.calls.length
    selection.drag('move', { x: 180, y: 60 })
    selection.dispose()
    selection.drag('down', { x: 25, y: 5 })
    expect(select).toHaveBeenCalledTimes(calls)
    expect(selection.isActive()).toBe(false)
  })
})

describe('Android selection quote to conversation', () => {
  it('hides the action when the program has no bracketed paste', () => {
    const { selection, quoteButton } = fixture({ text: 'alpha' })
    selection.start({ x: 25, y: 5 })
    expect(quoteButton().hidden).toBe(true)
  })

  it('pastes a Markdown quote into the AI CLI and closes the selection', () => {
    const { selection, term, quoteButton } = fixture({ canQuote: () => true, text: 'alpha   \nbeta' })
    selection.start({ x: 25, y: 5 })
    expect(quoteButton().hidden).toBe(false)
    quoteButton().click()
    expect(term.paste).toHaveBeenCalledWith('> alpha\n> beta\n')
    expect(selection.isActive()).toBe(false)
  })

  it('rechecks writability on click instead of pasting into a plain shell', () => {
    let allowed = true
    const { selection, term, quoteButton } = fixture({ canQuote: () => allowed, text: 'alpha' })
    selection.start({ x: 25, y: 5 })
    allowed = false
    quoteButton().click()
    expect(term.paste).not.toHaveBeenCalled()
    expect(quoteButton().hidden).toBe(true)
  })
})

describe('Android selection copy', () => {
  it('closes the selection after a successful copy', async () => {
    const { selection, copyText, container } = fixture({ text: 'alpha' })
    selection.start({ x: 25, y: 5 })
    const copyButton = [...container.querySelectorAll<HTMLButtonElement>('.terminal-selection-tools button')]
      .find(button => button.textContent === '复制')!
    copyButton.click()
    await vi.waitFor(() => expect(selection.isActive()).toBe(false))
    expect(copyText).toHaveBeenCalledWith('alpha')
  })

  it('keeps the selection open when copying fails', async () => {
    const { selection, copyText, container } = fixture({ text: 'alpha' })
    copyText.mockRejectedValueOnce(new Error('复制失败，请重试'))
    selection.start({ x: 25, y: 5 })
    const copyButton = [...container.querySelectorAll<HTMLButtonElement>('.terminal-selection-tools button')]
      .find(button => button.textContent === '复制')!
    copyButton.click()
    await vi.waitFor(() => expect(copyButton.disabled).toBe(false))
    expect(selection.isActive()).toBe(true)
  })
})
