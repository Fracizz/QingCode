import { save } from '@tauri-apps/plugin-dialog'
import { isTauri, safeInvoke } from '../tauri'
import { authorizePaths } from '../pathAllowlist'
import { translate } from '../i18n'
import { terminalExportName } from './terminalContent'

export async function exportTerminalContent(text: string, name: string): Promise<boolean> {
  const defaultPath = terminalExportName(name)
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = defaultPath
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  }
  const path = await save({
    title: translate('导出终端内容（含已保留的历史输出）'),
    defaultPath,
    filters: [{ name: translate('文本文件'), extensions: ['txt'] }],
  })
  if (!path) return false
  await authorizePaths([path])
  await safeInvoke('导出终端内容', 'write_file', { path, content: text, encoding: 'utf-8' })
  return true
}
