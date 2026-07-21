import { describe, expect, it } from 'vitest'
import { shouldPreventNativeContextMenu } from './contextMenuGuard'

const prod = { allowNativeContextMenu: false } as const
const dev = { allowNativeContextMenu: true } as const

describe('shouldPreventNativeContextMenu', () => {
  it.each([null, {} as EventTarget])(
    'does not prevent native menus in dev builds',
    target => {
      expect(shouldPreventNativeContextMenu(target, dev)).toBe(false)
    },
  )

  it('prevents native menus when there is no DOM target in production', () => {
    expect(shouldPreventNativeContextMenu(null, prod)).toBe(true)
  })
})
