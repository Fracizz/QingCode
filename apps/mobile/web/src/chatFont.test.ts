import { expect, it } from 'vitest'
import { fitChatFont } from './chatFont'

it('对话字号取整并限制在支持范围内', () => {
  expect(fitChatFont(4)).toBe(8)
  expect(fitChatFont(17.6)).toBe(18)
  expect(fitChatFont(200)).toBe(32)
  expect(fitChatFont(NaN)).toBe(16)
})
