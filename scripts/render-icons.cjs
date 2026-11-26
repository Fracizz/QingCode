// 用 Electron 离屏渲染 branding/icon.svg，生成桌面端 PNG / ICO。
// 运行：pnpm icons（= electron scripts/render-icons.cjs）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'branding/icon.svg'), 'utf8')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const PNG_OUT = [
  ['apps/desktop/build/icon.png', 1024],
  ['branding/icon-512.png', 512],
  ['apps/desktop/src/renderer/public/icon.png', 256],
]

// ICO 允许直接内嵌 PNG（Vista+），按尺寸从小到大写入目录项。
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((x) => x.png)])
}

async function render(win, size) {
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  win.setContentSize(size, size)
  await new Promise((r) => setTimeout(r, 150))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true },
  })
  win.webContents.setZoomFactor(1)
  const images = []
  for (const size of ICO_SIZES) images.push({ size, png: await render(win, size) })
  fs.writeFileSync(path.join(root, 'apps/desktop/build/icon.ico'), buildIco(images))
  for (const [file, size] of PNG_OUT) {
    const out = path.join(root, file)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, await render(win, size))
  }
  console.log('icons written:', ['apps/desktop/build/icon.ico', ...PNG_OUT.map((x) => x[0])].join(', '))
  app.quit()
})
