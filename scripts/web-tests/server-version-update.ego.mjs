import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export async function run({ spaceId, artifactDir } = {}) {
  const output = artifactDir ?? resolve(tmpdir(), `qingcode-version-update-${Date.now()}`).replaceAll('\\', '/')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode remote version update acceptance')
  const page = task.page('p1')
  const results = []
  const step = async (name, action) => { await action(); results.push({ name, status: 'passed' }) }
  const count = () => page.evaluate(() => document.querySelector('[data-testid="update-calls"]').textContent)
  const complete = () => page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '完成更新').click())
  try {
    await page.goto('http://127.0.0.1:38439/web-tests/server-version-update.html')
    await page.waitForSelector('loc=role:button[name*="远端服务版本不匹配 阶段"]')
    const window = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId })
    await task.cdp('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
    await step('overview shows both versions and an enabled update action during probing', async () => {
      await page.click('loc=role:button[name*="远端服务版本不匹配 阶段"]')
      await page.waitForSelector('loc=role:button[name="通过 SSH 更新远端服务"]')
      const summary = await page.evaluate(() => document.querySelector('[role="status"]').textContent)
      assert.match(summary, /0\.1\.14-beta\.9/)
      assert.match(summary, /0\.1\.14-beta\.12/)
      assert.doesNotMatch(summary, /准备完成后/)
      await page.screenshot({ path: `${output}/version-mismatch.png` })
    })
    await step('cancel leaves the service untouched', async () => {
      await page.click('loc=role:button[name="通过 SSH 更新远端服务"]')
      await page.waitForSelector('loc=role:button[name="更新并重新连接"]')
      await page.click('loc=role:button[name="取消"]')
      assert.equal(await count(), '0')
    })
    await step('failed SSH update remains visible and allows retry', async () => {
      await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '切换更新失败').click())
      await page.click('loc=role:button[name="通过 SSH 更新远端服务"]')
      await page.click('loc=role:button[name="更新并重新连接"]')
      await page.waitForSelector('loc=role:button[name="正在更新…"]')
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('section[aria-busy="true"] button')].every(button => button.disabled)))
      assert.equal(await count(), '1')
      await complete()
      await page.waitForSelector('[role="alert"]')
      assert.match(await page.evaluate(() => document.querySelector('[role="alert"]').textContent), /identity changed/)
      await page.click('loc=role:button[name="取消"]')
    })
    await step('English update authorization fits a narrow light window', async () => {
      await page.click('loc=role:button[name="关闭对话框"]')
      await page.click('loc=role:button[name="切换语言主题"]')
      await page.waitForSelector('loc=role:button[name*="Remote service version mismatch"]')
      await page.click('loc=role:button[name*="Remote service version mismatch"]')
      await page.click('loc=role:button[name="Update remote service via SSH"]')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: `${output}/update-light-narrow-en.png` })
      await page.click('loc=role:button[name="Cancel"]')
      await page.click('loc=role:button[name="Close dialog"]')
      await page.click('loc=role:button[name="切换语言主题"]')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
    })
    await step('successful retry refreshes the open overview to beta.12', async () => {
      await page.click('loc=role:button[name="切换更新失败"]')
      await page.click('loc=role:button[name*="远端服务版本不匹配 阶段"]')
      await page.click('loc=role:button[name="通过 SSH 更新远端服务"]')
      await page.click('loc=role:button[name="更新并重新连接"]')
      await page.waitForSelector('loc=role:button[name="正在更新…"]')
      await complete()
      await page.waitForSelector('loc=role:button[name="重新连接 Server"]')
      assert.equal(await count(), '2')
      assert.match(await page.evaluate(() => document.querySelector('[role="status"]').textContent), /远端服务已就绪/)
      await page.screenshot({ path: `${output}/version-updated.png` })
    })
    await writeFile(`${output}/results.json`, JSON.stringify({ results, nativeSsh: false }, null, 2))
    console.log({ output, results })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(`${output}/results.json`, JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    throw error
  }
}
