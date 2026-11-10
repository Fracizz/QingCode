// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { focusHoveredMenuItem } from './menuHoverFocus'

describe('focusHoveredMenuItem', () => {
  it('焦点跟随悬停的可用菜单项，跳过禁用与不可聚焦项', () => {
    render(
      <div role="menu" onMouseOver={focusHoveredMenuItem}>
        <button type="button" role="menuitem">第一项</button>
        <button type="button" role="menuitem"><span>第二项</span></button>
        <button type="button" role="menuitem" disabled>禁用项</button>
        <div role="menuitem" tabIndex={-1}>不可用项</div>
      </div>,
    )
    const first = screen.getByRole('menuitem', { name: '第一项' })
    first.focus()
    fireEvent.mouseOver(screen.getByText('第二项'))
    const second = screen.getByRole('menuitem', { name: '第二项' })
    expect(second).toHaveFocus()
    fireEvent.mouseOver(screen.getByRole('menuitem', { name: '禁用项' }))
    fireEvent.mouseOver(screen.getByRole('menuitem', { name: '不可用项' }))
    expect(second).toHaveFocus()
  })
})
