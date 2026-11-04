import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Use the normal dev:web-test server: its stores are not replaced by project-manager adapters. */
export async function run({ spaceId, artifactDir, url = 'http://127.0.0.1:38419/web-tests/run-config-discovery.html' } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/run-config-discovery')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode run config discovery')
  const page = task.page('p1')
  const results = []
  const step = async (name, action) => {
    try { await action(); results.push({ name, status: 'passed' }) }
    catch (error) { results.push({ name, status: 'failed', error: String(error) }); throw error }
    finally { await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, boundary: 'Memory IPC; no native filesystem or task execution' }, null, 2)) }
  }
  const button = name => page.click(`loc=role:button[name="${name}"]`)
  const ready = () => page.waitForSelector('input[aria-label="选择发现的任务「dev」"]', { state: 'visible', timeout: 10000 })
  await page.goto(url)
  await ready()
  await step('discovery is read-only, duplicates disabled and candidates unselected', async () => {
    const state = await page.evaluate(() => ({
      duplicate: document.querySelector('input[aria-label="选择发现的任务「build」"]').disabled,
      selected: document.querySelector('input[aria-label="选择发现的任务「dev」"]').checked,
      commands: window.runDiscoveryFixture.commands,
    }))
    assert.equal(state.duplicate, true)
    assert.equal(state.selected, false)
    assert.ok(state.commands.every(command => ['scan_directory', 'read_file_slice', 'read_file'].includes(command)))
    await button('取消')
    assert.equal(await page.evaluate(() => window.runDiscoveryFixture.writes), 0)
  })
  await step('save failure keeps selection and dialog; retry combines tasks and preserves existing config', async () => {
    await page.click('input[aria-label="模拟保存失败"]')
    await button('打开发现'); await ready()
    await page.click('input[aria-label="全选发现的任务"]')
    await page.click('loc=role:checkbox[name="合并为一个配置（每项独立终端）"]')
    await button('导入选中（2）')
    await page.waitForSelector('[role="alert"]', { state: 'visible' })
    assert.equal(await page.evaluate(() => window.runDiscoveryFixture.writes), 0)
    assert.equal(await page.evaluate(() => document.querySelector('input[aria-label="选择发现的任务「dev」"]').checked), true)
    await button('取消')
    await page.click('input[aria-label="模拟保存失败"]')
    await button('打开发现'); await ready()
    await page.click('input[aria-label="全选发现的任务"]')
    await page.click('loc=role:checkbox[name="合并为一个配置（每项独立终端）"]')
    await button('导入选中（2）')
    await page.waitForSelector('[role="dialog"]', { state: 'hidden' })
    const saved = await page.evaluate(() => JSON.parse(document.querySelector('[data-testid="saved-configs"]').textContent))
    assert.equal(saved.length, 2)
    assert.equal(saved[0].id, 'existing')
    assert.deepEqual(saved[1].tasks.map(task => [task.target, task.cwd ?? '']), [['pnpm run dev', ''], ['pnpm run start', 'api']])
    assert.equal(saved[1].restoreWithProjectSession, false)
  })
  await step('reopening prevents duplicate import and reveals skipped files/scripts', async () => {
    await button('打开发现'); await ready()
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input[aria-label^="选择发现"]')].every(input => input.disabled)), true)
    await page.click('[role="dialog"] summary')
    assert.ok((await page.evaluate(() => document.querySelector('[role="dialog"]').textContent)).includes('broken/package.json'))
    await page.screenshot({ path: resolve(output, 'dark.png') })
    await button('取消')
  })
  await step('English light theme fits a narrow viewport and Escape closes', async () => {
    await button('切换主题'); await button('切换语言'); await button('打开发现')
    await page.waitForSelector('input[aria-label="Select discovered task “dev”"]', { state: 'visible' })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false })
    const bounds = await page.evaluate(() => {
      const rect = document.querySelector('[role="dialog"]').getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }
    })
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height)
    await page.screenshot({ path: resolve(output, 'light-en-narrow.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="dialog"]', { state: 'hidden' })
    await page.cdp('Emulation.clearDeviceMetricsOverride')
  })
  await task.finish({ keep: [] })
  console.log({ results, output })
}
