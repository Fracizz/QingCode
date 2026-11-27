import { contextBridge, ipcRenderer, webUtils } from 'electron'

// MessagePort 不能经 contextBridge 传对象，只能由 preload 转发到页面主世界。
ipcRenderer.on('backend-port', (event) => {
  const port = event.ports[0]
  if (port) window.postMessage('qn-backend-port', '*', [port])
})

const isSmoke = new URLSearchParams(window.location.search).get('smoke') === '1'

contextBridge.exposeInMainWorld('qn', {
  openFile: (kind?: 'sshKey' | 'legacyDb'): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openFile', kind ?? 'sshKey'),
  downloadFile: (targetId: string, root: string, path: string, openAfterDownload = false): Promise<boolean> =>
    ipcRenderer.invoke('file:download', targetId, root, path, openAfterDownload),
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  smokeDone: (): void => ipcRenderer.send('app:smokeDone'),
  requestPort: (): void => ipcRenderer.send('backend-port-request'),
  isSmoke,
  // 自绘标题栏需要按平台给系统窗口按钮留位（Windows 在右、macOS 在左）。
  platform: process.platform,
  // 粘贴/拖入的文件在本机的真实路径（沙箱下 File.path 已移除，只能经 webUtils 取）；剪贴板图片等无路径时返回空串。
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})
