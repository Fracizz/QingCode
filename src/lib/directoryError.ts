import { formatInvokeErrorMessage } from './formatDocument'
import { translate } from './i18n'

/**
 * Localize backend directory-unavailable payloads (Chinese source keys).
 * Also accepts the legacy English form for older builds / cached errors.
 */
export function formatDirectoryErrorDetail(error: unknown): string {
  const message = formatInvokeErrorMessage(error)
  const match = message.match(/^(?:目录不可用|Directory is unavailable):\s*(.+)$/)
  if (match) {
    return translate('目录不可用: {path}', { path: match[1].trim() })
  }
  return message
}

/** Toast for expandDir / expandProjectDir failures. */
export function formatExpandDirErrorToast(error: unknown): string {
  return translate('展开目录失败: {error}', {
    error: formatDirectoryErrorDetail(error),
  })
}

/** Toast for loadFileTree / ensureProjectTree failures. */
export function formatReadDirErrorToast(error: unknown): string {
  return translate('读取目录失败: {error}', {
    error: formatDirectoryErrorDetail(error),
  })
}

/** Toast for refreshProjectTree failures. */
export function formatRefreshDirErrorToast(error: unknown): string {
  return translate('刷新目录失败: {error}', {
    error: formatDirectoryErrorDetail(error),
  })
}
