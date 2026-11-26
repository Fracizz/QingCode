import { describe, expect, it } from 'vitest'
import { encodeDirectCode } from '@qn/protocol'
import { extractDirectInfo } from './TargetForm'

const fingerprint = 'ab'.repeat(32)
const info = {
  v: 1 as const,
  hosts: ['192.168.10.87', '10.0.0.4'],
  port: 47390,
  token: 't'.repeat(43),
  fingerprint,
  name: '测试机',
}
const code = encodeDirectCode(info)

describe('从粘贴文本里提取直连连接码', () => {
  it('容忍前后说明文字与换行', () => {
    const text = `直连连接码：\n  ${code}\n按 Ctrl+C 退出\n`
    expect(extractDirectInfo(text)).toEqual(info)
  })

  it('容忍连接码被折行、尾部跟着英文', () => {
    const wrapped = `${code.slice(0, 24)}\n${code.slice(24)} copy now`
    expect(extractDirectInfo(wrapped)).toEqual(info)
  })

  it('没有连接码或码无效时返回 null', () => {
    expect(extractDirectInfo('随便一段文字')).toBeNull()
    expect(extractDirectInfo('qn-direct:not-a-code')).toBeNull()
    expect(extractDirectInfo(`qn-direct:${'A'.repeat(64)}`)).toBeNull()
    expect(extractDirectInfo(code.slice(0, code.length - 10))).toBeNull()
  })
})
