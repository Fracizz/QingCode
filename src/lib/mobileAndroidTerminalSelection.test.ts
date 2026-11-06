// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalSelection } from '../../mobile/android/web/terminalSelection.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks() })

function fixture() {
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
    getSelection: () => '', selectAll: vi.fn(), scrollLines: vi.fn(),
    onScroll: subscribe, onRender: subscribe, onResize: subscribe,
  }
  const selection = attachTerminalSelection({ term, container, copyText: vi.fn() })
  disposers.push(() => selection.dispose())
  return { selection, select }
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
