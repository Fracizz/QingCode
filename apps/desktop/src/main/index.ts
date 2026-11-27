import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  shell,
  utilityProcess,
} from 'electron'
import { registerSecretHandlers } from './secrets'

const smoke = process.argv.includes('--smoke')
const isDev = !app.isPackaged
const appRoot = app.getAppPath()
const preloadPath = join(appRoot, 'out', 'preload', 'index.cjs')
const backendPath = join(appRoot, 'out', 'main', 'backend.js')
const rendererHtml = join(appRoot, 'out', 'renderer', 'index.html')
// 打包后 resourcesPath 下由 electron-builder 放 server/，开发时直接用仓库内 resources/。
const resourcesPath = isDev ? join(appRoot, 'resources') : process.resourcesPath

type BackendChild = ReturnType<typeof utilityProcess.fork>

let win: BrowserWindow | null = null
let child: BackendChild | null = null
let childSpawned = false
let rendererPort: Electron.MessagePortMain | null = null
let pendingBackendPort: Electron.MessagePortMain | null = null
let windowReady = false
let shuttingDown = false
let smokeTimer: NodeJS.Timeout | null = null
let restartTimer: NodeJS.Timeout | null = null

function deliverPort(): void {
  if (!windowReady || !rendererPort || !win || win.isDestroyed()) return
  const port = rendererPort
  rendererPort = null
  win.webContents.postMessage('backend-port', null, [port])
}

// 每次调用都建一对全新的 port：窗口重载、backend 重启、渲染进程补要 port 都会走这里。
function createChannel(): void {
  const { port1, port2 } = new MessageChannelMain()
  if (rendererPort) {
    try {
      rendererPort.close()
    } catch {
      // port 可能已随窗口销毁而关闭。
    }
  }
  rendererPort = port2
  if (child && childSpawned) {
    child.postMessage({ type: 'port' }, [port1])
  } else {
    if (pendingBackendPort) pendingBackendPort.close()
    pendingBackendPort = port1
  }
  deliverPort()
}

function startBackend(): void {
  if (shuttingDown) return
  const forked = utilityProcess.fork(backendPath, [], {
    serviceName: 'qingcode-next-backend',
    env: {
      ...process.env,
      QN_USER_DATA: app.getPath('userData'),
      QN_RESOURCES_PATH: resourcesPath,
      QN_ELECTRON_PATH: process.execPath,
      QN_APP_VERSION: app.getVersion(),
    },
  })
  child = forked
  childSpawned = false
  registerSecretHandlers(forked)

  forked.on('spawn', () => {
    childSpawned = true
    if (pendingBackendPort) {
      const port = pendingBackendPort
      pendingBackendPort = null
      forked.postMessage({ type: 'port' }, [port])
    }
  })
  forked.on('exit', () => {
    if (child === forked) {
      child = null
      childSpawned = false
    }
    if (shuttingDown) return
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = null
      startBackend()
      if (windowReady) createChannel()
    }, 500)
  })
}

function isAllowedNavigation(url: string): boolean {
  const current = win?.webContents.getURL() ?? ''
  if (url === current) return true
  try {
    const nextUrl = new URL(url)
    const currentUrl = new URL(current)
    return (
      nextUrl.protocol === currentUrl.protocol &&
      nextUrl.host === currentUrl.host &&
      nextUrl.pathname === currentUrl.pathname
    )
  } catch {
    return false
  }
}

// 与渲染进程 styles.css 的 --color-qn-chrome / 标题栏高度保持一致，否则系统窗口按钮与自绘标题栏会出现色差或错位。
const CHROME_COLOR = '#141414'
const CHROME_SYMBOL = '#a1a1aa'
// 与 styles.css 各主题的 --color-qn-chrome 保持一致，系统窗口按钮区才不会出现色块。
const THEME_CHROME: Record<string, { color: string; symbolColor: string }> = {
  dark: { color: CHROME_COLOR, symbolColor: CHROME_SYMBOL },
  gray: { color: '#232427', symbolColor: '#b4b4b8' },
  light: { color: '#ebebeb', symbolColor: '#4a4a4a' },
}
const TITLEBAR_HEIGHT = 38

// 去掉系统菜单后，开发态仍需要刷新与 DevTools 快捷键。
function installDevShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      window.webContents.toggleDevTools()
      event.preventDefault()
    } else if ((input.control && key === 'r') || key === 'f5') {
      window.webContents.reload()
      event.preventDefault()
    }
  })
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // 先隐藏，等进场页首帧绘制完成再显示，避免白屏闪烁。
    show: false,
    backgroundColor: CHROME_COLOR,
    // 隐藏系统标题栏但保留系统窗口按钮（Windows 11 悬停最大化按钮仍有贴靠布局）。
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: CHROME_COLOR, symbolColor: CHROME_SYMBOL, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win = window
  window.once('ready-to-show', () => window.show())
  // ready-to-show 偶尔不触发（渲染进程崩溃等），兜底显示窗口。
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }, 3000)
  if (isDev) installDevShortcuts(window)

  window.webContents.on('did-start-loading', () => {
    windowReady = false
  })
  window.webContents.on('did-finish-load', () => {
    windowReady = true
    createChannel()
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.on('closed', () => {
    if (win === window) win = null
    windowReady = false
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    const separator = devUrl.includes('?') ? '&' : '?'
    void window.loadURL(smoke ? `${devUrl}${separator}smoke=1` : devUrl)
  } else {
    void window.loadFile(rendererHtml, smoke ? { query: { smoke: '1' } } : undefined)
  }
}

function registerIpc(): void {
  // kind 只接受预设值，渲染进程不能传任意过滤器/标题。
  ipcMain.handle('dialog:openFile', async (_event, kind: unknown) => {
    const preset =
      kind === 'legacyDb'
        ? { title: '选择旧版 QingCode 数据库', filters: [{ name: 'SQLite 数据库', extensions: ['db'] }] }
        : { title: '选择 SSH 私钥文件', filters: [{ name: '私钥文件', extensions: ['pem', 'key', 'ppk'] }] }
    const result = await dialog.showOpenDialog({
      title: preset.title,
      properties: ['openFile'],
      filters: [...preset.filters, { name: '所有文件', extensions: ['*'] }],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  const downloading = new Set<string>()
  ipcMain.handle('file:download', async (event, targetId: string, root: string, path: string, openAfterDownload: unknown = false) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
      typeof targetId !== 'string' || typeof root !== 'string' || typeof path !== 'string' ||
      typeof openAfterDownload !== 'boolean') throw new Error('下载请求无效')
    const parts = path.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..' || /[:\\\x00-\x1f]/.test(part))) throw new Error('项目文件路径无效')
    const name = parts[parts.length - 1]!
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: openAfterDownload ? '下载并打开' : '下载到本机',
      defaultPath: join(app.getPath('downloads'), name),
    })
    if (canceled || !filePath) return false
    const backend = child
    if (!backend || !childSpawned) throw new Error('后台服务未连接')
    const destinationKey = process.platform === 'win32' ? filePath.toLowerCase() : filePath
    if (downloading.has(destinationKey)) throw new Error('已有下载正在使用此保存路径')
    downloading.add(destinationKey)
    try {
      const { port1, port2 } = new MessageChannelMain()
      await new Promise<void>((resolve, reject) => {
        port1.once('close', () => reject(new Error('下载连接已中断')))
        port1.once('message', ({ data }) => {
          if (data?.ok === true) resolve()
          else reject(new Error(data?.message || '下载失败'))
          port1.close()
        })
        port1.start()
        try {
          backend.postMessage({ type: 'download', targetId, root, path, destination: filePath }, [port2])
        } catch (error) {
          reject(error)
          port1.close()
          port2.close()
        }
      })
      if (openAfterDownload) {
        const error = await shell.openPath(filePath).catch((cause: unknown) =>
          cause instanceof Error ? cause.message : '系统打开文件失败',
        )
        if (error) throw new Error(`文件已下载，但无法打开：${error}`)
      }
      return true
    } finally {
      downloading.delete(destinationKey)
    }
  })
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.on('app:setTheme', (event, theme: unknown) => {
    const chrome = typeof theme === 'string' && Object.hasOwn(THEME_CHROME, theme) ? THEME_CHROME[theme] : undefined
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!chrome || !target || target.isDestroyed()) return
    target.setBackgroundColor(chrome.color)
    if (process.platform !== 'darwin') target.setTitleBarOverlay({ ...chrome, height: TITLEBAR_HEIGHT })
  })
  ipcMain.on('app:smokeDone', () => {
    if (!smoke) return
    if (smokeTimer) clearTimeout(smokeTimer)
    app.exit(0)
  })
  // 渲染进程若错过了 did-finish-load 时的 port，主动补要一次。
  ipcMain.on('backend-port-request', () => createChannel())
}

app.on('before-quit', () => {
  shuttingDown = true
  if (restartTimer) clearTimeout(restartTimer)
})

if (!app.requestSingleInstanceLock()) {
  // 已有实例时不抢窗口；smoke 必须以失败退出，避免误判。
  if (smoke) app.exit(1)
  else app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    // 自绘标题栏，不要系统菜单栏（Alt 也不会唤出）；复制粘贴等编辑快捷键由 Chromium 原生处理。
    // macOS 的 Cmd+C/V/Q 依赖应用菜单，只在其他平台去掉。
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    registerIpc()
    startBackend()
    createWindow()
    if (smoke) {
      smokeTimer = setTimeout(() => app.exit(1), 30_000)
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (!smoke && process.platform !== 'darwin') app.quit()
})
