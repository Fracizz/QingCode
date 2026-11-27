import { detectPathStyle, relativePath } from '../explorer/treeModel'
import { useTargets } from '../../store/targets'

const pending = new Set<string>()

export async function downloadProjectFile(targetId: string, root: string, path: string): Promise<void> {
  const key = JSON.stringify([targetId, path])
  if (pending.has(key)) return
  pending.add(key)
  try {
    if (detectPathStyle(root) === 'posix' && path.includes('\\')) throw new Error('下载接口不支持文件名中的反斜杠')
    const relative = relativePath(root, path).replaceAll('\\', '/')
    if (await window.qn.downloadFile(targetId, root, relative)) {
      useTargets.setState({ notice: `已下载 ${relative}` })
    }
  } catch (error) {
    useTargets.setState({ notice: error instanceof Error ? error.message : '下载失败' })
  } finally {
    pending.delete(key)
  }
}
