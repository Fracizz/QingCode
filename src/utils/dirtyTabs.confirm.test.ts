import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab } from '../types'
import { confirmDiscardTabs } from './dirtyTabs'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), save: vi.fn(), find: vi.fn(), flush: vi.fn(), autoSave: vi.fn(),
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog: mocks.confirm }))
vi.mock('../store/editorStore', () => ({ useEditorStore: { getState: () => ({ findTab: mocks.find, saveFile: mocks.save }) } }))
vi.mock('../lib/autoSave', () => ({ flushAutoSave: mocks.flush, shouldAutoSaveBeforeDiscard: mocks.autoSave }))
const dirty: EditorTab = { id: 'a', name: 'a.ts', path: '/work/a.ts', language: 'typescript', dirty: true }

describe('save before discarding tabs', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.find.mockReturnValue(dirty)
    mocks.autoSave.mockReturnValue(false)
  })

  it('keeps the operation cancelled when a save is rejected or leaves the buffer dirty', async () => {
    mocks.confirm.mockResolvedValue(true)
    mocks.save.mockResolvedValue(undefined)
    expect(await confirmDiscardTabs([dirty], '关闭文件')).toBe(false)
    expect(mocks.save).toHaveBeenCalledWith('a')
    mocks.save.mockRejectedValue(new Error('disk full'))
    expect(await confirmDiscardTabs([dirty], '关闭文件')).toBe(false)
  })

  it('proceeds only after all selected files have saved successfully', async () => {
    const other = { ...dirty, id: 'b', name: 'b.ts' }
    const current = new Map([['a', dirty], ['b', other]])
    mocks.find.mockImplementation(id => current.get(id))
    mocks.confirm.mockResolvedValue(true)
    mocks.save.mockImplementation(async id => current.set(id, { ...current.get(id)!, dirty: false }))
    expect(await confirmDiscardTabs([dirty, other], '关闭文件')).toBe(true)
    expect(mocks.save.mock.calls).toEqual([['a'], ['b']])
  })

  it('does not write on explicit discard or cancel', async () => {
    mocks.confirm.mockResolvedValue('alt')
    expect(await confirmDiscardTabs([dirty], '关闭文件')).toBe(true)
    mocks.confirm.mockResolvedValue(false)
    expect(await confirmDiscardTabs([dirty], '关闭文件')).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('uses the current dirty state after automatic saving', async () => {
    mocks.autoSave.mockReturnValue(true)
    mocks.flush.mockImplementation(async () => mocks.find.mockReturnValue({ ...dirty, dirty: false }))
    expect(await confirmDiscardTabs([dirty], '关闭文件')).toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})
