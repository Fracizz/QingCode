// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ConfirmDialog from './ConfirmDialog'
import { confirmDialogWithCheckbox, useConfirmStore } from '../store/confirmStore'

afterEach(() => useConfirmStore.getState().answer(false))

describe('confirmation checkbox', () => {
  it('starts checked, accepts opting out, and resets for the next confirmation', async () => {
    render(<ConfirmDialog />)
    const options = { title: '重启远端服务', message: 'SSH', checkbox: { label: '修复 SSH', defaultChecked: true } }
    let result!: ReturnType<typeof confirmDialogWithCheckbox>
    act(() => { result = confirmDialogWithCheckbox(options) })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await expect(result).resolves.toEqual({ confirmed: true, checked: false })
    act(() => { result = confirmDialogWithCheckbox(options) })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await expect(result).resolves.toEqual({ confirmed: false, checked: true })
  })

  it('closes a repair confirmation when its owning opening is cancelled', async () => {
    render(<ConfirmDialog />)
    const controller = new AbortController()
    let result!: ReturnType<typeof confirmDialogWithCheckbox>
    act(() => {
      result = confirmDialogWithCheckbox({
        title: '重启远端服务', message: 'SSH', signal: controller.signal,
        checkbox: { label: '修复 SSH', defaultChecked: true },
      })
    })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    act(() => controller.abort())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await expect(result).resolves.toEqual({ confirmed: false, checked: true })
  })
})
