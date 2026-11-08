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
    await page.keyboard.press('Escape')
    const cell = (col, row) => page.evaluate(([col, row]) => {
      const r = document.querySelector('.xterm-screen').getBoundingClientRect()
      const { cols, rows } = window.terminalFixture.state
      return { x: r.x + (r.width / cols) * (col + 0.5), y: r.y + (r.height / rows) * (row + 0.5) }
    }, [col, row])
    const clickCell = async (col, row, ctrl) => {
      const point = await cell(col, row)
      const away = await cell(col, row + 6)
      // xterm 按行缓存链接结果，内容变化后要先离开这一行再回来才会重新识别。
      await page.mouse.move(away.x, away.y, { label: 'leave terminal link row' })
      await page.mouse.move(point.x - 8, point.y, { label: 'approach terminal link' })
      await page.mouse.move(point.x, point.y, { steps: 2, label: 'hover terminal link' })
      await page.waitForFunction(() => document.querySelector('.xterm-screen').classList.contains('xterm-cursor-pointer'), undefined, { timeout: 3000 })
      if (ctrl) await page.keyboard.down('Control')
      await page.mouse.click(point.x, point.y, { label: ctrl ? 'Ctrl+click terminal link' : 'click terminal link' })
      if (ctrl) await page.keyboard.up('Control')
      await page.waitForTimeout(150)
    }
    const resetLinks = () => page.evaluate(() => {
      const { state } = window.terminalFixture
      state.opened.length = 0
      state.urls.length = 0
    })
    await step('file path opens only on Ctrl+click and carries line and column', async () => {
      await send('\x1bcsee src/a.ts:12:3 here')
      await resetLinks()
      await clickCell(8, 0, false)
      assert.deepEqual((await state()).opened, [])
      await clickCell(8, 0, true)
      assert.deepEqual((await state()).opened, [{ path: '/fixture/src/a.ts', line: 12, column: 3 }])
    })
    await step('missing file reports a toast instead of opening a tab', async () => {
      await send('\x1bcmissing/b.ts:1')
      await resetLinks()
      await clickCell(3, 0, true)
      assert.deepEqual((await state()).opened, [])
      assert.ok((await page.evaluate(() => window.terminalFixture.toasts())).some(text => text.includes('missing/b.ts')))
    })
    await step('file path still opens inside a mouse-tracking TUI', async () => {
      await send('\x1bc\x1b[?1049h\x1b[?1000h\x1b[?1006hsrc/a.ts:5')
      await resetLinks()
      await clickCell(2, 0, true)
      assert.deepEqual((await state()).opened, [{ path: '/fixture/src/a.ts', line: 5 }])
    })
    await step('OSC 8 file and editor links open in QingCode without a native confirm', async () => {
      await page.evaluate(() => { window.confirm = () => { throw new Error('native confirm must not run') } })
      await send('\x1bc\x1b]8;;file:///fixture/src/a.ts#L7\x07file-label\x1b]8;;\x07 \x1b]8;;vscode://file/fixture/src/a.ts:9:2\x07codex-label\x1b]8;;\x07')
      await resetLinks()
      await clickCell(3, 0, true)
      await clickCell(14, 0, true)
      assert.deepEqual((await state()).opened, [
        { path: '/fixture/src/a.ts', line: 7 },
        { path: '/fixture/src/a.ts', line: 9, column: 2 },
      ])
    })
    await step('OSC 8 web link confirms when its text hides the real address', async () => {
      await send('\x1bc\x1b]8;;https://other.test/x\x07good.dev\x1b]8;;\x07 \x1b]8;;https://a.test/\x07https://a.test/\x1b]8;;\x07')
      await resetLinks()
      await clickCell(3, 0, true)
      assert.equal(await page.evaluate(() => window.terminalFixture.confirmPending()), 'https://other.test/x')
      await page.evaluate(() => window.terminalFixture.answerConfirm(false))
      await page.waitForTimeout(100)
      assert.deepEqual((await state()).urls, [])
      await clickCell(12, 0, true)
      assert.equal(await page.evaluate(() => window.terminalFixture.confirmPending()), null)
      assert.deepEqual((await state()).urls, ['https://a.test/'])
    })
    await step('Shift+Enter sends LF in a TUI and stays CR in a plain shell', async () => {
      const shiftEnter = async () => {
        await page.focus('textarea[aria-label="Terminal input"]')
        await resetInput()
        await page.keyboard.press('Shift+Enter')
        return (await state()).input
      }
      await send('\x1bcplain shell')
      assert.deepEqual(await shiftEnter(), ['\r'])
      await send('\x1bc\x1b[?1004h')
      assert.deepEqual(await shiftEnter(), ['\n'])
      await send('\x1bc\x1b[?1049h')
      assert.deepEqual(await shiftEnter(), ['\n'])
      await send('\x1bc')
      assert.deepEqual(await shiftEnter(), ['\r'])
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
