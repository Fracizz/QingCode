import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439' } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/terminal-manager')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal manager 20261106')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const rows = '[role="dialog"] input[aria-label^="选择终端"]'
  const search = 'input[aria-label="搜索名称、项目、设备或状态"]'
  const remaining = () => page.evaluate(() => window.__terminalManagerFixture.terminals().length)
  const confirm = async () => {
    await page.waitForSelector('[role="alertdialog"]')
    await page.click('[role="alertdialog"] button:last-child')
    await page.waitForSelector('[role="alertdialog"]', { state: 'hidden' })
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.goto(baseUrl + '/web-tests/terminal-manager.html')
    await page.waitForSelector(rows)
    await step('65 terminals are paginated into 30 rows and the modal height is reduced', async () => {
      assert.equal(await page.evaluate(selector => document.querySelectorAll(selector).length, rows), 30)
      const bounds = await page.evaluate(() => {
        const rect = document.querySelector('[role="dialog"]').getBoundingClientRect()
        return { height: rect.height, viewport: innerHeight }
      })
      assert.ok(bounds.height <= bounds.viewport * .7)
      await page.click('button[aria-label="下一页"]')
      await page.click('button[aria-label="下一页"]')
      assert.equal(await page.evaluate(selector => document.querySelectorAll(selector).length, rows), 5)
      assert.equal(await page.evaluate(() => document.querySelector('button[aria-label="下一页"]').disabled), true)
      await page.screenshot({ path: resolve(output, 'last-page.png') })
    })
    await step('row selection survives pagination and select-all includes every result page', async () => {
      await page.click(rows + ' >> nth=0')
      await page.click('button[aria-label="上一页"]')
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('已选 1 / 65'))
      await page.click('input[aria-label="全选当前结果"]')
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('已选 65 / 65'))
      await page.click('loc=role:button[name="全部关闭"]')
      await page.waitForSelector('[role="alertdialog"]')
      assert.match(await page.evaluate(() => document.querySelector('#confirm-message').textContent), /65/)
      await page.click('loc=role:button[name="取消"]')
      assert.equal(await remaining(), 65)
      assert.deepEqual(await page.evaluate(() => window.__terminalManagerFixture.operations()), [])
    })
    await step('partial batch failures retain the failed row and selection, and retry closes it', async () => {
      await page.evaluate(() => window.__terminalManagerFixture.fail(['fixture-terminal-1']))
      await page.click('loc=role:button[name="全部关闭"]')
      await confirm()
      await page.waitForFunction(() => window.__terminalManagerFixture.terminals().length === 1)
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('已选 1 / 1'))
      assert.equal(await page.evaluate(() => window.__terminalManagerFixture.terminals()[0].id), 'fixture-terminal-1')
      assert.ok(await page.evaluate(() => window.__terminalManagerFixture.operations().some(operation => /1.*失败/.test(operation.action))))
      await page.screenshot({ path: resolve(output, 'partial-failure.png') })
      await page.evaluate(() => window.__terminalManagerFixture.fail([]))
      await page.click('loc=role:button[name="全部关闭"]')
      await confirm()
      await page.waitForFunction(() => window.__terminalManagerFixture.terminals().length === 0)
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('还没有终端'))
    })
    await step('filtered close-all affects all matching pages but never hidden terminals', async () => {
      await page.evaluate(() => window.__terminalManagerFixture.reset())
      await page.fill(search, 'finished')
      await page.waitForFunction(() => document.querySelectorAll('input[aria-label^="选择终端"]').length === 13)
      await page.click('loc=role:button[name="关闭筛选结果"]')
      await page.waitForSelector('[role="alertdialog"]')
      assert.match(await page.evaluate(() => document.querySelector('#confirm-message').textContent), /13/)
      await confirm()
      await page.waitForFunction(() => window.__terminalManagerFixture.terminals().length === 52)
      assert.ok(await page.evaluate(() => window.__terminalManagerFixture.terminals().every(tab => tab.status === 'running')))
      await page.fill(search, '')
      await page.waitForFunction(() => document.querySelectorAll('input[aria-label^="选择终端"]').length === 30)
    })
    await step('running-first is a temporary icon toggle beside search', async () => {
      const toggle = 'button[aria-label^="运行中优先"]'
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-pressed'), toggle), 'false')
      await page.click(toggle)
      await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-pressed') === 'true', toggle)
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-label'), toggle), '运行中优先 · 再点恢复默认顺序')
      await page.screenshot({ path: resolve(output, 'running-first.png') })
      await page.click(toggle)
      await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-pressed') === 'false', toggle)
    })
    await step('short narrow windows and English large-text layouts keep controls inside the viewport', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 480, deviceScaleFactor: 1, mobile: false })
      await page.evaluate(async () => {
        document.documentElement.dataset.theme = 'light'
        document.documentElement.style.setProperty('--ui-font-size', '17px')
        await window.__terminalManagerFixture.locale('en')
      })
      await page.waitForFunction(() => document.querySelector('#terminal-manager-title').textContent === 'Terminal manager')
      assert.ok(await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const rect = dialog.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth
      }))
      await page.screenshot({ path: resolve(output, 'english-narrow-light.png') })
    })
  } catch (error) {
    results.push({ name: 'failure', passed: false, error: String(error?.stack ?? error) })
    try { await page.screenshot({ path: resolve(output, 'failure.png') }) } catch {}
    throw error
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, nativeProcesses: false, results }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
  }
}
