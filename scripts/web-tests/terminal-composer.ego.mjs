import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 终端「编辑长文本」非模态浮动面板：无遮罩、可拖动、默认高度、Escape 归属与位置记忆。 */
export async function run({ spaceId, screenshots = true, artifactDir } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests', `terminal-composer-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal composer floating panel 20261105')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  const panelRect = () => page.evaluate(() => {
    const r = document.querySelector('[data-terminal-composer]').getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  })
  const openComposer = async () => {
    await page.mouse.click(200, 120, { button: 'right', label: 'open terminal context menu' })
    await page.waitForSelector('[role="menu"]')
    await page.click('loc=role:menuitem[name="编辑长文本"]', { label: 'open long text panel' })
    await page.waitForSelector('[data-terminal-composer]', { state: 'visible' })
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await page.goto('http://127.0.0.1:38419/web-tests/terminal-interaction.html')
    await page.evaluate(() => localStorage.removeItem('qingcode:terminal-composer-rect'))
    await page.reload()
    await page.waitForSelector('.xterm-screen')
    await page.evaluate(() => window.terminalFixture.output('\x1bcplain shell\r\nline to compare 1\r\nline to compare 2'))
    await openComposer()
    await step('opens as a tall non-modal panel without backdrop or blur', async () => {
      const info = await page.evaluate(() => ({
        overlay: !!document.querySelector('[data-modal-overlay]'),
        blurred: [...document.querySelectorAll('body *')].some(el => !['none', ''].includes(getComputedStyle(el).backdropFilter)),
        modal: document.querySelector('[data-terminal-composer]').getAttribute('aria-modal'),
        focused: document.activeElement?.getAttribute('aria-label'),
      }))
      assert.equal(info.overlay, false)
      assert.equal(info.blurred, false)
      assert.equal(info.modal, 'false')
      assert.equal(info.focused, '长文本内容')
      const rect = await panelRect()
      assert.equal(rect.height, Math.round(800 * 0.7))
      assert.equal(rect.x, (1280 - 840) / 2)
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'default.png') })
    await step('typing keeps the draft; Escape in the terminal does not close the panel', async () => {
      await page.fill('textarea[aria-label="长文本内容"]', '对照终端输出编写需求')
      await page.mouse.click(60, 400, { label: 'focus terminal beside panel' })
      await page.focus('textarea[aria-label="Terminal input"]')
      await page.evaluate(() => { window.terminalFixture.state.input.length = 0 })
      await page.keyboard.press('Escape')
      assert.equal(await page.evaluate(() => !!document.querySelector('[data-terminal-composer]')), true)
      const input = await page.evaluate(() => window.terminalFixture.state.input)
      assert.ok(input.includes('\x1b'), 'Escape should reach the terminal')
    })
    await step('dragging the title bar moves the panel and reveals the terminal', async () => {
      const before = await panelRect()
      await page.mouse.move(before.x + 300, before.y + 20, { label: 'grab panel title bar' })
      await page.mouse.down()
      await page.mouse.move(before.x + 300 + 200, before.y + 20 + 60, { steps: 10, label: 'drag panel aside' })
      await page.mouse.up()
      // 输入事件异步派发：等松手提交并持久化后再读位置。
      await page.waitForFunction(({ x, y }) => {
        const r = document.querySelector('[data-terminal-composer]').getBoundingClientRect()
        const stored = JSON.parse(localStorage.getItem('qingcode:terminal-composer-rect') ?? 'null')
        return Math.round(r.x) === x && Math.round(r.y) === y && stored?.x === x
      }, { x: before.x + 200, y: before.y + 60 }, { timeout: 5000 })
      const after = await panelRect()
      assert.equal(after.x, before.x + 200)
      assert.equal(after.y, before.y + 60)
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('qingcode:terminal-composer-rect')))
      assert.equal(stored.x, after.x)
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'dragged.png') })
    await step('Escape inside the panel closes it and the position is remembered', async () => {
      const dragged = await panelRect()
      await page.focus('textarea[aria-label="长文本内容"]')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-terminal-composer]', { state: 'detached' })
      await openComposer()
      assert.deepEqual(await panelRect(), dragged)
      assert.equal(await page.evaluate(() => document.querySelector('textarea[aria-label="长文本内容"]').value), '对照终端输出编写需求')
    })
    await step('double-clicking the title bar restores the centered default', async () => {
      const rect = await panelRect()
      await page.mouse.click(rect.x + 300, rect.y + 20, { label: 'focus panel title bar' })
      await page.dblclick('[data-terminal-composer-handle]', { label: 'reset panel position' })
      await page.waitForFunction(() => Math.round(document.querySelector('[data-terminal-composer]').getBoundingClientRect().x) === (1280 - 840) / 2, undefined, { timeout: 5000 })
      const reset = await panelRect()
      assert.equal(reset.x, (1280 - 840) / 2)
      assert.equal(reset.y, Math.round((800 - reset.height) / 2))
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots }, null, 2))
    console.log({ output, results, spaceId: task.spaceId })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, results, spaceId: task.spaceId, snapshot: await page.snapshot() })
    throw error
  }
}
