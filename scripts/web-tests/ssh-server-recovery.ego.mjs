import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, artifactDir, screenshots = true } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests', `ssh-server-recovery-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode service package recovery acceptance')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  const result = () => page.evaluate(() => JSON.parse(document.querySelector('[data-testid="recovery-result"]').textContent))
  const reset = async mode => {
    await page.goto('http://127.0.0.1:38439/web-tests/ssh-server-recovery.html')
    await page.waitForSelector('loc=role:button[name="关闭"]')
    if (mode) {
      await page.click('loc=role:button[name="关闭"]', { label: 'close simulated service error' })
      await page.selectOption('select[aria-label="测试服务包"]', mode)
      await page.click('loc=role:button[name="重新模拟错误"]', { label: 'show package recovery options' })
    }
    await page.waitForSelector('loc=role:button[name="重新选择服务目录"]')
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
    await reset()
    await step('version mismatch displays required version, package version and local source', async () => {
      await page.waitForFunction(() => document.querySelector('section[aria-label="修复远端服务包"]').textContent.includes('C:/Users/test'))
      const text = await page.evaluate(() => document.querySelector('section[aria-label="修复远端服务包"]').textContent)
      assert.match(text, /0\.1\.14-beta\.9/); assert.match(text, /0\.1\.14-beta\.1/)
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'version-error-dark.png') })
    await step('selecting an old directory preserves settings and does not retry', async () => {
      await page.click('loc=role:button[name="重新选择服务目录"]', { label: 'reject obsolete service directory' })
      await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes('Error:')))
      assert.equal((await result()).saves, 0); assert.equal((await result()).retries, 0)
    })
    await reset('cancel')
    await step('canceling directory selection does not change settings', async () => {
      await page.click('loc=role:button[name="重新选择服务目录"]', { label: 'cancel package directory selection' })
      await page.waitForFunction(() => !document.querySelector('section button').disabled)
      assert.equal((await result()).saves, 0)
    })
    await reset('network')
    await step('failed download keeps the previous source and allows another action', async () => {
      await page.click('loc=role:button[name="在线下载并重试"]', { label: 'inspect download failure recovery' })
      await page.waitForFunction(() => document.body.textContent.includes('Network offline'))
      assert.equal((await result()).saves, 0); assert.equal((await result()).retries, 0)
    })
    await reset('valid')
    await step('validated directory is saved and the failed project automatically retries', async () => {
      await page.click('loc=role:button[name="重新选择服务目录"]', { label: 'select matching service package' })
      await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).retries === 1)
      const state = await result(); assert.equal(state.saves, 1); assert.match(state.settings, /C:\/Downloads\/QingCode\/servers/)
      assert.equal(await page.evaluate(() => !!document.querySelector('[role="dialog"]')), false)
    })
    await reset()
    await step('online recovery selects the downloaded cache and automatically retries', async () => {
      await page.click('loc=role:button[name="在线下载并重试"]', { label: 'download verified service package' })
      await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).retries === 1)
      const state = await result(); assert.equal(state.saves, 1); assert.match(state.settings, /"ssh.server.autoDownload": true/)
    })
    await reset()
    await step('English labels remain usable in a narrow light window', async () => {
      await page.click('loc=role:button[name="关闭"]', { label: 'close before changing language' })
      await page.click('loc=role:button[name="切换语言"]', { label: 'inspect English recovery labels' })
      await page.click('loc=role:button[name="切换主题"]', { label: 'inspect light recovery panel' })
      await page.click('loc=role:button[name="重新模拟错误"]', { label: 'show translated recovery panel' })
      await page.waitForSelector('loc=role:button[name="Download and retry"]')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      if (screenshots) await page.screenshot({ path: resolve(output, 'version-error-light-narrow-en.png') })
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, nativeSsh: false }, null, 2))
    console.log({ output, results })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, spaceId: task.spaceId })
    throw error
  }
}
