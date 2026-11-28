import { describe, expect, it } from 'vitest'
import { folderCrumbs, formatFileTime, parentFolder } from './projectApi'

describe('项目文件路径与时间', () => {
  it('面包屑逐段给出相对路径', () => {
    expect(folderCrumbs('')).toEqual([])
    expect(folderCrumbs('apps/mobile/web')).toEqual([
      { name: 'apps', path: 'apps' },
      { name: 'mobile', path: 'apps/mobile' },
      { name: 'web', path: 'apps/mobile/web' },
    ])
    expect(parentFolder('apps/mobile')).toBe('apps')
    expect(parentFolder('apps')).toBe('')
  })

  it('今年内的时间省略年份，跨年写全', () => {
    const now = new Date(2026, 10, 28, 14, 0).getTime()
    expect(formatFileTime(new Date(2026, 10, 28, 13, 17).getTime(), 'en-US', now)).toBe('11/28, 13:17')
    expect(formatFileTime(new Date(2025, 0, 2, 9, 5).getTime(), 'en-US', now)).toBe('1/2/2025, 09:05')
    expect(formatFileTime(0, 'en-US', now)).toBe('')
  })
})
