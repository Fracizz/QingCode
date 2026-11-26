import { beforeEach, describe, expect, it } from 'vitest'
import { closeCommandPalette, openCommandPalette, toggleCommandPalette, useCommandPalette } from './paletteStore'

describe('paletteStore', () => {
  beforeEach(() => useCommandPalette.setState({ open: false, initialQuery: '', error: null, recent: [] }))

  it('打开 / 关闭 / 切换', () => {
    openCommandPalette('>')
    expect(useCommandPalette.getState()).toMatchObject({ open: true, initialQuery: '>' })
    closeCommandPalette()
    expect(useCommandPalette.getState().open).toBe(false)
    toggleCommandPalette()
    expect(useCommandPalette.getState()).toMatchObject({ open: true, initialQuery: '' })
    toggleCommandPalette()
    expect(useCommandPalette.getState().open).toBe(false)
  })

  it('showError 重新打开并显示错误，下次正常打开时清掉', () => {
    useCommandPalette.getState().showError('失败了')
    expect(useCommandPalette.getState()).toMatchObject({ open: true, error: '失败了' })
    closeCommandPalette()
    openCommandPalette()
    expect(useCommandPalette.getState().error).toBeNull()
  })

  it('markUsed 记录最近使用（无 localStorage 时不抛错）', () => {
    useCommandPalette.getState().markUsed('a')
    useCommandPalette.getState().markUsed('b')
    useCommandPalette.getState().markUsed('a')
    expect(useCommandPalette.getState().recent).toEqual(['a', 'b'])
  })
})
