import { contextBridge, ipcRenderer } from 'electron'

// MessagePort 不能经 contextBridge 传对象，只能由 preload 转发到页面主世界。
ipcRenderer.on('backend-port', (event) => {
  const port = event.ports[0]
  if (port) window.postMessage('qn-backend-port', '*', [port])
})

const isSmoke = new URLSearchParams(window.location.search).get('smoke') === '1'

contextBridge.exposeInMainWorld('qn', {
  openFile: (kind?: 'sshKey' | 'legacyDb'): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openFile', kind ?? 'sshKey'),
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  smokeDone: (): void => ipcRenderer.send('app:smokeDone'),
  requestPort: (): void => ipcRenderer.send('backend-port-request'),
  isSmoke,
  // 自绘标题栏需要按平台给系统窗口按钮留位（Windows 在右、macOS 在左）。
  platform: process.platform,
})
