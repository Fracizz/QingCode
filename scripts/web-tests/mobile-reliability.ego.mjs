import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real APK assets, memory RPC only; native queue behavior has separate JVM regressions.
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-reliability')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile reliability 20261104')
  const page = task.page('p1')
  const results = []
  const step = async (name, action) => { await action(); results.push({ name, passed: true }) }
  try {
    await page.goto(baseUrl + '/mobile-android/', { timeout: 60000 })
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    console.log({ spaceId: task.spaceId, snapshot: await page.snapshot() })
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.waitForSelector('#pair-dialog[open]')
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list .row:first-child')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')

    await step('a newer successful input clears current error but keeps the unknown original', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.inputError = '模拟弱网'; })
      await page.fill('#compose', 'first uncertain')
      await page.click('#send')
      await page.waitForFunction(() => document.querySelector('#submission-status').textContent.includes('结果未知'))
      await page.evaluate(() => { window.__mobileFixture.state.inputError = null; })
      await page.fill('#compose', 'second received')
      await page.click('#send')
      await page.waitForFunction(() => document.querySelector('#submission-status').textContent.includes('电脑已接收')
        && document.querySelector('#terminal-status').textContent === '会话中')
      await page.click('#review-submission')
      await page.waitForSelector('#submissions-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#submission-list').textContent.includes('first uncertain')), true)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.inputs.filter(item => item === 'first uncertain\r').length), 1)
      await page.evaluate(() => window.qingBack())
    })
    await page.screenshot({ path: resolve(output, 'recovered-input.png') })

    await step('long submission rows grow with their text instead of overlapping', async () => {
      for (const text of [
        "'D:\\code\\qingcode\\.qingcode\\terminal-paste\\mw5tfc5l-8jx0e2\\mobile-image.jpg' first long",
        "'D:\\code\\qingcode\\.qingcode\\terminal-paste\\mw4k4dpt-pkygfq\\mobile-image.jpg' second long",
        "'D:\\code\\qingcode\\.qingcode\\terminal-paste\\mw4dfw2y-5v53lx\\mobile-image.jpg' third long",
        'short row',
      ]) {
        await page.fill('#compose', text)
        await page.click('#send')
        await page.waitForFunction(text => window.__mobileFixture.state.inputs.includes(text + '\r'), text)
      }
      await page.click('#terminal-menu')
      await page.click('#menu-submissions')
      await page.waitForSelector('#submissions-dialog[open]')
      await page.screenshot({ path: resolve(output, 'long-submissions.png') })
      // 当前会话只留 3 条：压低窗口高度，让列表达到 max-height 才会触发行被压扁。
      for (const [width, height] of [[390, 520], [320, 480]]) {
        await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
        const rows = await page.evaluate(() => {
          const list = document.querySelector('#submission-list')
          return {
            canScroll: list.scrollHeight > list.clientHeight,
            sideways: list.scrollWidth > list.clientWidth,
            rows: [...list.children].map(row => {
              const rect = row.getBoundingClientRect()
              // button 的 scrollHeight 不计溢出的文字，用文字的实际范围判断。
              const range = document.createRange()
              range.selectNodeContents(row)
              const text = range.getBoundingClientRect()
              return { top: rect.top, bottom: rect.bottom, textTop: text.top, textBottom: text.bottom }
            }),
          }
        })
        assert.equal(rows.rows.length, 3, JSON.stringify(rows))
        assert.equal(rows.sideways, false, JSON.stringify(rows))
        assert.equal(rows.canScroll, true, JSON.stringify(rows))
        for (const row of rows.rows) assert.ok(row.textTop >= row.top && row.textBottom <= row.bottom, JSON.stringify(rows))
        for (let index = 1; index < rows.rows.length; index++) assert.ok(rows.rows[index].top >= rows.rows[index - 1].bottom - .5, JSON.stringify(rows))
      }
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
      await page.evaluate(() => window.qingBack())
    })

    await step('pending image does not disable Ctrl+C; successful upload only inserts a path', async () => {
      await page.evaluate(() => {
        window.__mobileFixture.state.imageGate = new Promise(resolve => { window.__releaseImage = resolve })
      })
      await page.click('#attach-image')
      await page.waitForFunction(() => document.querySelector('#image-state').textContent.includes('上传中'))
      await page.click('[data-key="interrupt"]')
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('\x03'))
      await page.evaluate(() => { window.__releaseImage(); })
      await page.waitForFunction(() => document.querySelector('#compose').value.includes('mobile-image.jpg'))
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.images.length), 1)
    })
    await step('capabilities are negotiated once and terminal profiles stay available', async () => {
      await page.click('#new-session')
      await page.waitForFunction(() => document.querySelectorAll('#terminal-profiles button').length === 4)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.capabilityRequests), 1)
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: resolve(output, 'profiles-320.png') })
      await page.evaluate(() => window.qingBack())
    })
    await step('older desktop without capabilities still provides a plain terminal', async () => {
      await page.evaluate(() => {
        window.__mobileFixture.state.capabilities = null
        window.__mobileFixture.state.terminalProfiles = null
        window.qingLink(window.__mobileFixture.link('192.168.1.8', 49000))
      })
      await page.waitForSelector('#pair-dialog[open]')
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit')
      await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
      await page.click('#dashboard-nav [data-page="project"]')
      await page.click('#project-list .row:first-child')
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await page.click('#new-session')
      await page.waitForFunction(() => !document.querySelector('#terminal-profiles-error').hidden)
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#terminal-profiles button')].map(button => button.textContent)), ['新建终端'])
      await page.evaluate(() => window.qingBack())
    })
    await step('landscape and keyboard-height layouts keep controls within viewport', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true })
      await page.evaluate(() => window.qingOrientation(true))
      await page.waitForFunction(() => window.__mobileFixture.state.fullscreen)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: resolve(output, 'landscape.png') })
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 400, deviceScaleFactor: 1, mobile: true })
      await page.evaluate(() => window.qingOrientation(false))
      await page.waitForFunction(() => !window.__mobileFixture.state.fullscreen)
      assert.equal(await page.evaluate(() => document.querySelector('#compose-form').getBoundingClientRect().bottom <= innerHeight + 1), true)
      await page.screenshot({ path: resolve(output, 'keyboard-height.png') })
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeAndroid: false, engine: 'ego-browser', results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
    return task.spaceId
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, results })
    throw error
  }
}
