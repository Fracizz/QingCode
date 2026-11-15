import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FONT_KEY = 'qingcode:font-settings'
const PAGE = 'http://127.0.0.1:38419/web-tests/terminal-interaction.html'
const phone = { id: 'phone', kind: 'device', name: '手机', observe: false, typing: true }

/**
 * 多端共享：手机是尺寸方时电脑按字号把手机网格铺满窗口；电脑自己的行列仍按设置字号报给后端；
 * 改窗口重新铺满；平板宽网格放进窄窗口时缩小；电脑重新成为尺寸方后恢复设置字号与网格。
 * 先启动 `pnpm dev:web-test`（38419）。
 */
export async function run({ spaceId, screenshots = true, artifactDir } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests', 'terminal-follow-fit')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal follow fit')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  const wait = ms => new Promise(done => setTimeout(done, ms))
  const state = () => page.evaluate(() => ({ cols: window.terminalFixture.state.cols, rows: window.terminalFixture.state.rows }))
  const control = payload => page.evaluate(payload => window.terminalFixture.control(payload), payload)
  const follow = (rev, cols, rows, name = '手机') => control({
    rev, cols, rows, sizeOwner: name, sizeOwnerKind: 'device', viewers: [{ ...phone, name }],
  })
  /** 终端画面与可用区域（容器扣除内边距与滚动条，同 FitAddon）。 */
  // 读 xterm 写在画面上的样式尺寸：设备模拟下 getBoundingClientRect 可能停在旧值。
  const layout = () => page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen')
    const host = document.querySelector('.xterm').parentElement
    return {
      screen: { width: parseFloat(screen.style.width), height: parseFloat(screen.style.height) },
      area: { width: host.clientWidth - 14, height: host.clientHeight },
    }
  })
  // xterm 的字格宽度 = 画布宽度 / 当前列数，画布按整像素取整，同一窗口在不同列数下可能差一列。
  const sameGrid = (actual, expected) => assert.ok(
    Math.abs(actual.cols - expected.cols) <= 1 && actual.rows === expected.rows,
    `grid ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  )
  const shotErrors = []
  // 截图超时只记录不影响断言（Ego 在设备模拟改宽后偶发截图无响应）。
  const shot = async name => {
    if (!screenshots) return
    try { await page.screenshot({ path: resolve(output, `${name}.png`) }) }
    catch (error) { shotErrors.push({ name, error: String(error).split('\n')[0] }) }
  }
  const viewport = width => page.cdp('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
  const fills = ({ screen, area }) => {
    assert.ok(screen.width <= area.width + 1 && screen.height <= area.height + 1, `screen ${JSON.stringify(screen)} exceeds ${JSON.stringify(area)}`)
    const filled = Math.max(screen.width / area.width, screen.height / area.height)
    assert.ok(filled >= 0.85, `screen fills only ${(filled * 100).toFixed(0)}% of ${JSON.stringify(area)}`)
  }
  try {
    await viewport(1280)
    await page.goto(PAGE)
    await page.evaluate(key => localStorage.removeItem(key), FONT_KEY)
    await page.goto(PAGE)
    await page.waitForSelector('.xterm-screen')
    await wait(600)
    // 设备模拟把 DPR 改成 1 后，首次 fit 量到的是旧 DPR 下的字格；动一下窗口让网格按真实字格重排。
    await viewport(1279)
    await wait(400)
    await viewport(1280)
    await wait(600)
    // 写几行 60 列以内的内容，截图里能看出放大后的字号。
    await page.evaluate(() => window.terminalFixture.output(
      Array.from({ length: 12 }, (_, i) => `PS C:/work> echo line-${String(i).padStart(2, '0')} 手机控制中`).join('\r\n')))
    const own = await state()
    const ownLayout = await layout()

    await step('phone-sized grid is enlarged to fill the wide desktop window', async () => {
      await follow(1, 60, 20)
      await wait(600)
      const now = await layout()
      fills(now)
      // 字格明显变大：同样铺满窗口，60 列的每格比电脑自己的网格宽。
      assert.ok(now.screen.width / 60 > (ownLayout.screen.width / own.cols) * 1.5, 'phone grid is enlarged')
      // 字号放大后电脑自己的行列不变：电脑打字成为尺寸方时用的仍是设置字号下的网格。
      sameGrid(await state(), own)
      await shot('01-phone-grid-filled')
    })

    let narrowOwn
    await step('resizing the window refits the phone grid and reports the base-font grid', async () => {
      await viewport(900)
      await wait(800)
      fills(await layout())
      narrowOwn = await state()
      assert.ok(narrowOwn.cols < own.cols, `own cols ${own.cols} -> ${narrowOwn.cols}`)
      await shot('02-narrow-window')
    })

    await step('a wide tablet grid shrinks to fit a narrow window', async () => {
      await follow(2, 200, 50, '平板')
      await wait(800)
      const now = await layout()
      assert.ok(now.screen.width <= now.area.width + 1, `screen ${now.screen.width} > ${now.area.width}`)
      fills(now)
      sameGrid(await state(), narrowOwn)
      await shot('03-tablet-grid-shrunk')
    })

    await step('desktop owning the size again restores the configured font and its own grid', async () => {
      await control({ rev: 3, sizeOwnerKind: 'desktop', viewers: [] })
      await wait(800)
      const restored = await state()
      sameGrid(restored, narrowOwn)
      // 字格宽度回到设置字号（与刚打开时的电脑网格一致），画面重新铺满电脑自己的行列。
      const now = await layout()
      const cell = now.screen.width / restored.cols
      const ownCell = ownLayout.screen.width / own.cols
      assert.ok(Math.abs(cell - ownCell) < 0.2, `cell ${cell} vs ${ownCell}`)
      assert.ok(now.area.width - now.screen.width < cell * 2, `screen ${now.screen.width} in ${now.area.width}`)
      await shot('04-restored')
      // 测试页（含未跟随时）在 Ego 里拉宽窗口不会触发重新 fit，宽窗恢复不在这里断言。
      await viewport(1280)
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, shotErrors }, null, 2))
    console.log({ output, results, shotErrors, spaceId: task.spaceId })
    await task.finish({ keep: [] })
  } catch (error) {
    await shot('failure').catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, results, error: String(error), spaceId: task.spaceId })
    throw error
  }
}
