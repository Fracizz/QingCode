import { expect, it } from 'vitest'
import { parseImageCompression, parseTheme } from './mobilePreferences'

it('图片压缩只有高、中、低三档，缺省或未知值回到中档', () => {
  expect(parseImageCompression('high')).toBe('high')
  expect(parseImageCompression('low')).toBe('low')
  expect(parseImageCompression(undefined)).toBe('medium')
  expect(parseImageCompression('max')).toBe('medium')
})

it('主题与电脑版一致只有深色、灰色、浅色，旧值迁移到对应主题', () => {
  expect(parseTheme('dark')).toBe('dark')
  expect(parseTheme('gray')).toBe('gray')
  expect(parseTheme('light')).toBe('light')
  // 旧版「石墨灰」并入灰色，「跟随系统」和未知值回到默认深色。
  expect(parseTheme('graphite')).toBe('gray')
  expect(parseTheme('system')).toBe('dark')
  expect(parseTheme('olive')).toBe('dark')
  expect(parseTheme(undefined)).toBe('dark')
})
