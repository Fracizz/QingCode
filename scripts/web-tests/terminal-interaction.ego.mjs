import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, screenshots = true, artifactDir } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests', `terminal-interaction-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode OpenCode Claude terminal interaction 20261029')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  const state = () => page.evaluate(() => window.terminalFixture.state)
  const send = data => page.evaluate(data => window.terminalFixture.output(data), data)
  const resetInput = () => page.evaluate(() => { window.terminalFixture.state.input.length = 0 })
  const select = async () => {
    const grid = await page.evaluate(() => {
      const r = document.querySelector('.xterm-screen').getBoundingClientRect()
      const { cols, rows } = window.terminalFixture.state
      return { x: r.x, y: r.y, cw: r.width / cols, ch: r.height / rows }
    })
    await page.keyboard.down('Shift')
    await page.mouse.move(grid.x + grid.cw * 0.5, grid.y + grid.ch * 0.5, { label: 'select Claude terminal output' })
    await page.mouse.down()
    await page.mouse.move(grid.x + grid.cw * 31.5, grid.y + grid.ch * 0.5, { steps: 12, label: 'extend terminal text selection' })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    return { x: grid.x + grid.cw * 10, y: grid.y + grid.ch * 0.5 }
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await page.goto('http://127.0.0.1:38419/web-tests/terminal-interaction.html')
    await page.waitForSelector('.xterm-screen')
    const tui = '\x1bc\x1b[?1049hClaude copy selection regression\r\nOpenCode message actions\x1b[?1000h\x1b[?1006h'
    await send(tui)
    await step('history replay never overwrites the clipboard', async () => {
      assert.deepEqual((await state()).writes, [])
    })
    await step('OpenCode OSC 52 copies UTF-8 text and does not answer clipboard queries', async () => {
      await resetInput()
      await send('\x1b]52;c;5L2g5aW9IE9wZW5Db2Rl\x07\x1b]52;c;?\x07')
      assert.equal((await state()).clipboard, '你好 OpenCode')
      assert.deepEqual((await state()).input, [])
    })
    await step('unselected TUI right-click reaches the application without a QingCode menu', async () => {
      await resetInput()
      await page.mouse.click(100, 75, { button: 'right', label: 'open TUI message actions' })
      assert.equal(await page.evaluate(() => !!document.querySelector('[role="menu"]')), false)
      assert.ok((await state()).input.some(data => /\x1b\[<2;\d+;\d+M/.test(data)))
      assert.ok((await state()).input.some(data => /\x1b\[<2;\d+;\d+m/.test(data)))
    })
    let selected
    await step('Claude Shift selection copies using Ctrl+C and Ctrl+Shift+C without TUI input', async () => {
      await send(tui)
      await select()
      await resetInput()
      await page.keyboard.press('Control+c')
      selected = (await state()).clipboard
      assert.match(selected, /Claude copy selection/)
      await page.keyboard.press('Control+Shift+c')
      assert.equal((await state()).clipboard, selected)
      assert.deepEqual((await state()).input, [])
    })
    await step('Claude selected right-click suppresses both mouse reports and copies after redraw', async () => {
      const point = await select()
      await resetInput()
      await page.mouse.click(point.x, point.y, { button: 'right', label: 'copy selected Claude text' })
      await page.waitForSelector('[role="menu"]')
      assert.deepEqual((await state()).input, [])
      await send('\x1b[H\x1b[2Koutput changed after menu opened')
      if (screenshots) await page.screenshot({ path: resolve(output, 'claude-selected-menu.png') })
      await page.click('loc=css:[role="menuitem"] >> nth=0', { label: 'copy saved selection text' })
      assert.equal((await state()).clipboard, selected)
    })
    await step('right-click keeps the selected text when output arrives before contextmenu', async () => {
      await send(tui)
      const point = await select()
      await resetInput()
      // Split the gesture to exercise an output/contextmenu race deterministically.
      await page.evaluate(point => document.querySelector('.xterm-screen').dispatchEvent(
        new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true, clientX: point.x, clientY: point.y })
      ), point)
      await send('\x1b[H\x1b[2Kselection cleared before contextmenu')
      await page.evaluate(point => {
        document.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('contextmenu', {
          button: 2, bubbles: true, cancelable: true, clientX: point.x, clientY: point.y,
        }))
        document.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true, cancelable: true }))
      }, point)
      await page.waitForSelector('[role="menu"]')
      assert.equal(await page.evaluate(() => document.querySelector('[role="menuitem"]').disabled), false)
      await page.click('loc=css:[role="menuitem"] >> nth=0', { label: 'copy text captured at right-button press' })
      assert.equal((await state()).clipboard, selected)
      assert.deepEqual((await state()).input, [])
    })
    await step('Shift right-click opens the QingCode menu without TUI mouse reports', async () => {
      await send(tui)
      await resetInput()
      await page.keyboard.down('Shift')
      await page.mouse.click(100, 75, { button: 'right', label: 'open terminal context menu' })
      await page.keyboard.up('Shift')
      await page.waitForSelector('[role="menu"]')
      assert.deepEqual((await state()).input, [])
      await page.keyboard.press('Escape')
    })
    await step('Ctrl+C without selection still interrupts; ordinary shell keeps its menu', async () => {
      await send('\x1bcplain shell')
      await page.focus('textarea[aria-label="Terminal input"]')
      await resetInput()
      await page.keyboard.press('Control+c')
      assert.deepEqual((await state()).input, ['\x03'])
      await page.mouse.click(100, 75, { button: 'right', label: 'open shell context menu' })
      await page.waitForSelector('[role="menu"]')
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, nativeSsh: false, screenshots }, null, 2))
    console.log({ output, results, spaceId: task.spaceId, snapshot: await page.snapshot() })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, spaceId: task.spaceId, snapshot: await page.snapshot() })
    throw error
  }
}
