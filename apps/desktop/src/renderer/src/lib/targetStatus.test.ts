import { describe, expect, it } from 'vitest'
import { isTargetActive, isTargetBusy, matchTarget } from './targetStatus'

describe('target status helpers', () => {
  it('连接中与部署中视为忙碌，且属于活动状态', () => {
    expect(isTargetBusy('connecting')).toBe(true)
    expect(isTargetBusy('deploying')).toBe(true)
    expect(isTargetBusy('ready')).toBe(false)
    expect(isTargetActive('ready')).toBe(true)
    expect(isTargetActive('error')).toBe(false)
    expect(isTargetActive('idle')).toBe(false)
  })

  it('按名称、主机、用户名搜索，忽略大小写与首尾空格', () => {
    const target = { name: '测试机 93', kind: 'ssh', host: '192.168.10.93', username: 'root' }
    expect(matchTarget(target, '')).toBe(true)
    expect(matchTarget(target, ' 93 ')).toBe(true)
    expect(matchTarget(target, 'ROOT')).toBe(true)
    expect(matchTarget(target, '10.87')).toBe(false)
    expect(matchTarget({ name: '本机', kind: 'local' }, '本机')).toBe(true)
  })
})
