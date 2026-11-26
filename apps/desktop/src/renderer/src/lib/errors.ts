import { BackendCallError } from './backend'

const rawMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return ''
}

const errorCode = (err: unknown): string => {
  if (err instanceof BackendCallError) return err.code
  const record = err as { code?: unknown } | null
  return typeof record?.code === 'string' ? record.code : ''
}

export function isNotImplemented(err: unknown): boolean {
  if (errorCode(err) === 'not_implemented') return true
  return /not_implemented|尚未实现|not implemented/i.test(rawMessage(err))
}

export function isActiveWriterError(err: unknown): boolean {
  return /thread \S+ already has an active writer\b/i.test(rawMessage(err))
}

export function friendlyError(err: unknown, fallback = '操作失败'): string {
  if (isActiveWriterError(err)) return '会话被另一个 Codex 进程占用。请关闭原客户端中的会话，或退出原客户端后重试'
  const code = errorCode(err)
  if (code === 'not_implemented') return `${fallback}：后端功能尚未接入，当前版本暂不可用`
  if (code === 'unknown_method') return `${fallback}：后端不支持此操作，请升级到最新版本`
  if (code === 'auth') return `${fallback}：认证失败，请检查用户名或凭据`
  if (code === 'port_replaced') return `${fallback}：通信通道已重建，请重试`
  if (code === 'protocol' || code === 'protocol_version') return `${fallback}：协议版本不匹配，请更新两端程序`

  const raw = rawMessage(err)
  if (!raw) return fallback
  if (/not_implemented|尚未实现|not implemented/i.test(raw)) {
    return `${fallback}：后端功能尚未接入，当前版本暂不可用`
  }
  return raw
}

export function describeCodexOpenError(err: unknown, targetId: string): string {
  const raw = rawMessage(err)
  const codexMissing =
    /codex/i.test(raw) &&
    /ENOENT|not found|未找到|找不到|spawn|login|未安装|未登录|exited/i.test(raw)
  if (codexMissing || /ENOENT|not found/i.test(raw)) {
    return targetId === 'local'
      ? '本机未找到 codex，请先安装并 `codex login`'
      : '远端未找到 codex，请确认已安装 codex-cli 并完成登录'
  }
  return friendlyError(err, '打开 Codex 失败')
}

export function jsonRpcErrorCode(err: unknown): number {
  if (err instanceof BackendCallError) {
    const numeric = Number(err.code)
    return Number.isFinite(numeric) && numeric !== 0 ? numeric : -32000
  }
  return -32000
}
