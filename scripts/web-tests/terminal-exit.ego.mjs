import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, artifactDir, screenshots = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `terminal-exit-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal exit diagnostics 20261028')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => {
    await work()
    results.push({ name, status: 'passed' })
  }
  try {
    await page.goto('http://127.0.0.1:38439/web-tests/terminal-exit.html')
    await page.waitForSelector('[role="status"]')
    console.log({ spaceId: task.spaceId, snapshot: await page.snapshot() })
    await step('abnormal exit preserves evidence and waits for an explicit action', async () => {
      assert.match(await page.evaluate(() => document.querySelector('[role="status"]').textContent), /退出码 1/)
      assert.equal(await page.evaluate(() => document.querySelector('output').textContent), 'reopened=0; exported=0')
    })
    await step('export does not restart a terminal', async () => {
      await page.click('loc=role:button[name="导出终端诊断"]', { label: 'export terminal evidence' })
      await page.waitForFunction(() => document.querySelector('output').textContent === 'reopened=0; exported=1')
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'dark.png') })
    await step('explicit reopen keeps history and dismisses the ended notice', async () => {
      await page.click('loc=role:button[name="重新打开终端"]', { label: 'open a fresh shell' })
      await page.waitForFunction(() => !document.querySelector('[role="status"]'))
      assert.match(await page.evaluate(() => document.querySelector('pre').textContent), /Claude 历史输出已保留\nPowerShell >/)
    })
    await step('lost session has no fabricated exit code', async () => {
      await page.click('loc=role:button[name="模拟会话丢失"]', { label: 'inspect lost session notice' })
      await page.waitForSelector('[role="status"]')
      assert.match(await page.evaluate(() => document.querySelector('[role="status"]').textContent), /会话已结束/)
      assert.doesNotMatch(await page.evaluate(() => document.querySelector('[role="status"]').textContent), /退出码/)
    })
    await step('English translations and narrow light layout', async () => {
      await page.click('loc=role:button[name="切换语言"]', { label: 'check English notice' })
      await page.waitForSelector('loc=role:button[name="Reopen terminal"]')
      await page.click('loc=role:button[name="切换主题"]', { label: 'check light theme' })
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 600, deviceScaleFactor: 1, mobile: false })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      if (screenshots) await page.screenshot({ path: resolve(output, 'light-narrow-en.png') })
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, nativeSsh: false, screenshots }, null, 2))
    console.log({ output, results, snapshot: await page.snapshot() })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, spaceId: task.spaceId })
    throw error
  }
}
