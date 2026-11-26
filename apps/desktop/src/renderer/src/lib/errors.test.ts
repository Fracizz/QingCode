import { describe, expect, it } from 'vitest'
import { BackendCallError } from './backend'
import { describeCodexOpenError, friendlyError, isNotImplemented, jsonRpcErrorCode, readableAgentError } from './errors'

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

describe('readableAgentError', () => {
  it('把内嵌的 JSON 换成其中的 message', () => {
    expect(readableAgentError('429: {"type":"GoUsageLimitError","message":"usage limit reached"}')).toBe(
      '429 · usage limit reached',
    )
    expect(readableAgentError('API Error: 400 {"error":{"message":"bad model"}}')).toBe('API Error: 400 · bad model')
  })

  it('不是 JSON 或没有 message 时原样返回', () => {
    expect(readableAgentError('Turn failed')).toBe('Turn failed')
    expect(readableAgentError('x {not json}')).toBe('x {not json}')
    expect(readableAgentError('x {"code":1}')).toBe('x {"code":1}')
  })
})
