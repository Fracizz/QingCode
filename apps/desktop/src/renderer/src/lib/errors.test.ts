import { describe, expect, it } from 'vitest'
import { BackendCallError } from './backend'
import { describeCodexOpenError, friendlyError, isNotImplemented, jsonRpcErrorCode } from './errors'

describe('错误提示', () => {
  it('把 not_implemented 翻译成友好提示', () => {
    const err = new BackendCallError('not_implemented', 'projects.list 尚未实现')
    expect(isNotImplemented(err)).toBe(true)
    expect(friendlyError(err, '加载项目')).toContain('后端功能尚未接入')
    expect(friendlyError(new Error('not_implemented'), '刷新会话')).toContain('后端功能尚未接入')
  })

  it('常见错误码与无消息回退', () => {
    expect(friendlyError(new BackendCallError('auth', 'x'), '连接')).toContain('认证失败')
    expect(friendlyError(new BackendCallError('port_replaced', 'x'), '连接')).toContain('重试')
    expect(friendlyError(new Error('磁盘不可读'), '读取')).toBe('磁盘不可读')
    expect(friendlyError(null, '保存项目')).toBe('保存项目')
    expect(isNotImplemented(new Error('其他错误'))).toBe(false)
  })

  it('codex 缺失时按本机/远端给出明确指引', () => {
    expect(describeCodexOpenError(new Error('spawn codex ENOENT'), 'local')).toContain('本机未找到 codex')
    expect(describeCodexOpenError(new Error('codex not found'), 'ssh-1')).toContain('远端未找到 codex')
    expect(describeCodexOpenError(new BackendCallError('not_implemented', 'x'), 'local')).toContain(
      '后端功能尚未接入',
    )
  })

  it('JSON-RPC 错误码始终是数字', () => {
    expect(jsonRpcErrorCode(new BackendCallError('not_implemented', 'x'))).toBe(-32000)
    expect(jsonRpcErrorCode(new BackendCallError('-32601', 'x'))).toBe(-32601)
    expect(jsonRpcErrorCode(new Error('x'))).toBe(-32000)
  })
})
