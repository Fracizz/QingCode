import { describe, expect, it } from 'vitest'
import { terminalContextMenuEntries } from './terminalContextMenu'

const ids = (state: Parameters<typeof terminalContextMenuEntries>[0]) =>
  terminalContextMenuEntries(state).map(entry => (entry.separatorBefore ? `|${entry.id}` : entry.id))

describe('terminalContextMenuEntries', () => {
  it('有选区且在 AI CLI 中时显示复制/添加到对话/粘贴', () => {
    expect(ids({ hasSelection: true, canQuote: true, writable: true })).toEqual([
      'copy',
      'quote',
      'paste',
      '|find',
      '|export',
      'clear',
    ])
  })

  it('程序未开启 bracketed paste 时添加到对话灰显而不是消失', () => {
    const entries = terminalContextMenuEntries({ hasSelection: true, canQuote: false, writable: true })
    expect(entries.map(entry => entry.id)).toEqual(['copy', 'quote', 'paste', 'find', 'export', 'clear'])
    expect(entries.find(entry => entry.id === 'quote')?.disabled).toBe(true)
    expect(
      terminalContextMenuEntries({ hasSelection: true, canQuote: true, writable: true }).find(
        entry => entry.id === 'quote'
      )?.disabled
    ).toBeUndefined()
  })

  it('无选区时显示粘贴/全选/编辑长文本，不显示复制', () => {
    expect(ids({ hasSelection: false, canQuote: false, writable: true })).toEqual([
      'paste',
      'selectAll',
      'composer',
      '|find',
      '|export',
      'clear',
    ])
  })

  it('只读终端隐藏全部写入类操作', () => {
    expect(ids({ hasSelection: true, canQuote: true, writable: false })).toEqual([
      'copy',
      '|find',
      '|export',
      'clear',
    ])
    expect(ids({ hasSelection: false, canQuote: false, writable: false })).toEqual([
      'selectAll',
      '|find',
      '|export',
      'clear',
    ])
  })
})
