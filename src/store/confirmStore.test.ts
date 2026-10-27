import { afterEach, describe, expect, it } from 'vitest'
import { confirmDialog, confirmDialogWithCheckbox, useConfirmStore } from './confirmStore'

afterEach(() => useConfirmStore.getState().answer(false))

describe('confirmation ownership and cancellation', () => {
  it('does not replace an existing dialog when given an already cancelled signal', async () => {
    const current = confirmDialog({ title: 'current', message: '' })
    const controller = new AbortController()
    controller.abort()
    await expect(confirmDialog({ title: 'cancelled', message: '', signal: controller.signal })).resolves.toBe(false)
    expect(useConfirmStore.getState().request?.title).toBe('current')
    useConfirmStore.getState().answer('alt')
    await expect(current).resolves.toBe('alt')
  })

  it('does not dismiss another confirmation when an older operation is cancelled', async () => {
    const controller = new AbortController()
    const old = confirmDialog({ title: 'old', message: '', signal: controller.signal })
    const current = confirmDialog({ title: 'current', message: '' })
    controller.abort()
    await expect(old).resolves.toBe(false)
    expect(useConfirmStore.getState().request?.title).toBe('current')
    useConfirmStore.getState().answer(true)
    await expect(current).resolves.toBe(true)
  })

  it('captures the checked choice before another dialog resets the checkbox', async () => {
    const old = confirmDialogWithCheckbox({ title: 'old', message: '', checkbox: { label: 'repair', defaultChecked: true } })
    useConfirmStore.getState().answer(true)
    const current = confirmDialog({ title: 'current', message: '' })
    await expect(old).resolves.toEqual({ confirmed: true, checked: true })
    useConfirmStore.getState().answer(false)
    await expect(current).resolves.toBe(false)
  })
})
