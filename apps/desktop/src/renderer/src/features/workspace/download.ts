import { t, translateMessage } from '@qn/codex-client'
import { detectPathStyle, relativePath } from '../explorer/treeModel'
import { useTargets } from '../../store/targets'

const pending = new Set<string>()

export async function downloadProjectFile(targetId: string, root: string, path: string, openAfterDownload = false): Promise<void> {
  const key = JSON.stringify([targetId, path])
  if (pending.has(key)) return
  pending.add(key)
  try {
    if (detectPathStyle(root) === 'posix' && path.includes('\\')) throw new Error(t('下载接口不支持文件名中的反斜杠'))
    const relative = relativePath(root, path).replaceAll('\\', '/')
    if (await window.qn.downloadFile(targetId, root, relative, openAfterDownload)) {
      useTargets.setState({ notice: openAfterDownload ? t('已下载并打开 {path}', { path: relative }) : t('已下载 {path}', { path: relative }) })
    }
  } catch (error) {
    // Electron 会给主进程抛出的错误加前缀，去掉后才能整句匹配译文。
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') : ''
    useTargets.setState({ notice: message ? translateMessage(message) : t('下载失败') })
  } finally {
    pending.delete(key)
  }
}
