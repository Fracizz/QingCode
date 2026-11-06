// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
// 虚拟鼠标在历史面板里选字：选词、拖动延伸、复制文本与清除。
import { attachHistorySelection, wordRange } from '../../mobile/android/web/historySelection.js'

type CaretDocument = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }

afterEach(() => {
  document.body.replaceChildren()
  delete (document as CaretDocument).caretRangeFromPoint
  window.getSelection()?.removeAllRanges()
})

/** jsdom 没有布局：用 x 表示第几个字符，y 表示第几个文本节点。 */
function fixture(lines = ['hello world', 'second line']) {
  const content = document.createElement('pre')
  content.append(...lines.map(line => { const span = document.createElement('span'); span.textContent = line; return span }))
  const outside = document.createElement('p')
  outside.textContent = 'outside text'
  document.body.append(content, outside)
  ;(document as CaretDocument).caretRangeFromPoint = (x, y) => {
    const node = y < 0 ? outside.firstChild! : content.children[y].firstChild!
    const range = document.createRange()
    range.setStart(node, x)
    return range
  }
  return attachHistorySelection(content)
}

describe('Android history selection', () => {
  it('expands to the surrounding non-space run', () => {
    expect(wordRange('hello world', 2)).toEqual([0, 5])
    expect(wordRange('hello world', 8)).toEqual([6, 11])
    expect(wordRange('hello world', 5)).toEqual([5, 6])
    expect(wordRange('hello', 99)).toEqual([0, 5])
    expect(wordRange('', 0)).toEqual([0, 0])
  })

  it('selects the word under the pointer', () => {
    const selection = fixture()
    expect(selection.start({ x: 8, y: 0 })).toBe(true)
    expect(selection.text()).toBe('world')
    selection.clear()
    expect(selection.text()).toBe('')
  })

  it('extends across nodes while dragging and stops after release', () => {
    const selection = fixture()
    selection.drag('down', { x: 6, y: 0 })
    expect(selection.text()).toBe('')
    selection.drag('move', { x: 6, y: 1 })
    expect(selection.text()).toBe('worldsecond')
    selection.drag('up', { x: 3, y: 1 })
    expect(selection.text()).toBe('worldsec')
    selection.drag('move', { x: 11, y: 1 })
    expect(selection.text()).toBe('worldsec')
  })

  it('ignores points outside the history content', () => {
    const selection = fixture()
    expect(selection.start({ x: 2, y: -1 })).toBe(false)
    selection.drag('down', { x: 2, y: -1 })
    selection.drag('move', { x: 4, y: 0 })
    expect(selection.text()).toBe('')
  })
})
