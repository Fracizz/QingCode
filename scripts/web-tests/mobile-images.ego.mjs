import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real Android web assets; image picking and upload use the in-memory bridge.
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, screenshots = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-images-ego')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode Android original image 20261104')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const step = async (name, action) => { await action(); results.push({ name, passed: true }) }
  const openSettings = async () => {
    await page.click('#manage-sessions', { label: 'open terminal settings' })
    await page.waitForSelector('#session-dialog[open]')
    await page.waitForFunction(() => !document.querySelector('#session-dialog').getAnimations().some(animation => animation.playState === 'running'))
    await page.click('#open-settings-from-terminal', { label: 'open settings' })
    await page.waitForSelector('#settings-dialog[open]')
  }
  // 返回键依次关闭设置页与终端设置。
  const closeSettings = () => page.evaluate(() => { window.qingBack(); window.qingBack() })
  const openProject = async () => {
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.waitForSelector('#pair-dialog[open]')
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'show project list' })
    await page.click('#project-list .row:first-child', { label: 'open fixture project' })
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/')
    // Reset only this localhost fixture's app records.
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await openProject()
    await step('original option is available alongside compression and saves immediately', async () => {
      await openSettings()
      assert.equal(await page.evaluate(() => document.querySelector('#image-compression').value), 'medium')
      await page.selectOption('#image-compression', { label: '原图 · 不压缩' })
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:image-compression')), 'original')
      assert.match(await page.evaluate(() => document.querySelector('#image-compression-hint').textContent), /PNG \/ JPEG.*HEIC \/ HEIF.*8 MB/)
      await closeSettings()
    })
    await step('original mode reaches the picker and inserts an attachment without submitting', async () => {
      await page.fill('#compose', '请分析原图 ')
      await page.click('#attach-image', { label: 'upload original image' })
      await page.waitForFunction(() => !document.querySelector('#attach-image').disabled && window.__mobileFixture.state.images.length === 1)
      assert.deepEqual(await page.evaluate(() => ({
        mode: window.__mobileFixture.state.imageCompression,
        draft: document.querySelector('#compose').value,
        inputs: window.__mobileFixture.state.inputs,
      })), { mode: 'original', draft: "请分析原图 '/tmp/mobile-image.jpg' ", inputs: [] })
    })
    await step('oversized original keeps the draft and can retry with compression', async () => {
      await page.fill('#compose', '保留说明 ')
      await page.evaluate(() => { window.__mobileFixture.state.imageError = '图片不能超过 8 MB' })
      await page.click('#attach-image', { label: 'try oversized original image' })
      await page.waitForSelector('#image-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '保留说明 ')
      assert.match(await page.evaluate(() => document.querySelector('#image-error').textContent), /8 MB/)
      await page.click('#image-dialog [data-close]', { label: 'close upload error' })
      await openSettings()
      await page.selectOption('#image-compression', 'high')
      await closeSettings()
      await page.evaluate(() => { window.__mobileFixture.state.imageError = null })
      await page.click('#attach-image', { label: 'upload compressed image' })
      await page.waitForFunction(() => !document.querySelector('#attach-image').disabled && window.__mobileFixture.state.images.length === 2)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.imageCompression), 'high')
    })
    await openSettings()
    await page.selectOption('#image-compression', 'original')
    await step('original option and its explanation fit a 320px phone', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
      await page.evaluate(() => document.querySelector('#image-compression').scrollIntoView({ block: 'center' }))
      assert.ok(await page.evaluate(() => {
        const option = document.querySelector('#image-compression').getBoundingClientRect()
        const hint = document.querySelector('#image-compression-hint').getBoundingClientRect()
        return option.left >= 0 && option.right <= innerWidth && option.height >= 44
          && hint.left >= 0 && hint.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
      }))
      if (screenshots) await page.screenshot({ path: resolve(output, 'original-settings-320.png') })
    })
    await step('original preference survives reload and is used for the next upload', async () => {
      await page.reload()
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
      await page.waitForFunction(() => typeof window.qingLink === 'function')
      assert.equal(await page.evaluate(() => document.querySelector('#image-compression').value), 'original')
      // The fixture's native pairing/session records are in memory and reset on reload.
      await openProject()
      await page.click('#attach-image', { label: 'reuse original after reload' })
      await page.waitForFunction(() => !document.querySelector('#attach-image').disabled && window.__mobileFixture.state.images.length === 1)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.imageCompression), 'original')
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, results }, null, 2))
    await task.finish({ keep: [] })
    console.log(JSON.stringify({ output, results }, null, 2))
  } catch (error) {
    results.push({ passed: false, error: String(error) })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, spaceId: task.spaceId, results }, null, 2))
    throw error
  }
}
