import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FONT_KEY = 'qingcode:font-settings'

export async function run({ spaceId, screenshots = true, artifactDir } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests', `terminal-font-zoom-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal font zoom')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  const state = () => page.evaluate(() => window.terminalFixture.state)
  const send = data => page.evaluate(data => window.terminalFixture.output(data), data)
  const fontSize = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size').trim())
  const wheel = async (deltaY, modifiers = 2) => {
    const box = await page.evaluate(() => {
      const r = document.querySelector('.xterm-screen').getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY, modifiers })
    await new Promise(done => setTimeout(done, 450))
  }
  // 滑块未贴底即正在翻看历史。
  const scrolledUp = () => page.evaluate(() => {
    // 外观 rect 带过渡动画，这里读 xterm 写入的目标位置。
    const slider = document.querySelector('.xterm .scrollbar.vertical > .slider')
    const track = slider?.parentElement
    if (!slider || !track) return null
    return parseFloat(slider.style.top) + parseFloat(slider.style.height) < parseFloat(track.style.height) - 1
  })
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await page.goto('http://127.0.0.1:38419/web-tests/terminal-interaction.html')
    await page.evaluate(key => localStorage.removeItem(key), FONT_KEY)
    await page.goto('http://127.0.0.1:38419/web-tests/terminal-interaction.html')
    await page.waitForSelector('.xterm-screen')
    await new Promise(done => setTimeout(done, 600))

    await step('Ctrl+wheel up zooms in once per notch and shrinks the grid', async () => {
      const before = await state()
      assert.equal(await fontSize(), '13px')
      await wheel(-100)
      assert.equal(await fontSize(), '14px')
      const after = await state()
      assert.ok(after.cols < before.cols, `cols ${before.cols} -> ${after.cols}`)
    })
    await step('Ctrl+wheel down zooms out and the size persists', async () => {
      await wheel(100)
      await wheel(100)
      assert.equal(await fontSize(), '12px')
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).terminalFontSize, FONT_KEY)
      assert.equal(saved, 12)
    })
    await step('page itself does not zoom', async () => {
      assert.equal(await page.evaluate(() => window.visualViewport.scale), 1)
    })
    await step('Ctrl+wheel is not forwarded to a mouse-tracking TUI, a plain wheel still is', async () => {
      await send('\x1b[?1049h\x1b[?1000h\x1b[?1006h')
      await page.evaluate(() => { window.terminalFixture.state.input.length = 0 })
      await wheel(-100)
      assert.deepEqual((await state()).input, [])
      await wheel(100, 0)
      assert.ok((await state()).input.some(data => /\x1b\[<65;\d+;\d+M/.test(data)))
      await send('\x1b[?1000l\x1b[?1006l\x1b[?1049l')
    })
    await step('zooming keeps the reading position in scrollback', async () => {
      await send(Array.from({ length: 300 }, (_, i) => `history line ${i}`).join('\r\n'))
      await wheel(-400, 0)
      assert.equal(await scrolledUp(), true)
      await wheel(-100)
      assert.equal(await scrolledUp(), true)
    })
    await step('zoom stops at the upper limit', async () => {
      for (let i = 0; i < 24; i++) {
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: -100, modifiers: 2 })
      }
      await new Promise(done => setTimeout(done, 500))
      assert.equal(await fontSize(), '32px')
    })
    await page.evaluate(key => localStorage.removeItem(key), FONT_KEY)
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots }, null, 2))
    console.log({ output, results, spaceId: task.spaceId })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, results, error: String(error), spaceId: task.spaceId })
    throw error
  }
}
