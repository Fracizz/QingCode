import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as sidebarRegression } from './mobile-sidebar.ego.mjs'

// 真实侧栏与关闭流程；仅关闭内存桥里的会话，不操作电脑端真实进程。
export async function run({ spaceId, finish = true, regression = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-session-close')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode session closing 20261104')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const drawer = async () => {
    if (!await page.evaluate(() => document.querySelector('#session-drawer').open)) await page.click('#show-sessions')
    await page.waitForFunction(() => document.querySelector('#session-drawer').open
      && !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
  }
  const row = id => `#session-options [data-id="${id}"]`
  const close = async (id, confirm = true) => {
    await drawer()
    await page.click(row(id) + ' .session-close', { label: 'close individual terminal' })
    await page.waitForSelector('#confirm-dialog[open]')
    await page.click(confirm ? '#confirm-action' : '#confirm-dialog [value="cancel"]', { label: confirm ? 'confirm terminal close' : 'keep terminal session' })
    await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open)
    if (confirm) await page.waitForFunction(() => !document.querySelector('#session-options .session-close:disabled'))
  }
  const count = expected => page.waitForFunction(n => document.querySelectorAll('#session-options .session-option').length === n, expected)
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
    await page.goto('http://127.0.0.1:38439/mobile-android/', { timeout: 60000 })
    await page.snapshot()
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list .row:first-child')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await page.evaluate(() => window.qingOrientation(false))
    await page.fill('#compose', '第一会话的草稿')
    for (let i = 2; i <= 3; i++) {
      await page.click('#new-session')
      await page.click('[data-profile="default"]')
      await page.waitForFunction(n => window.__mobileFixture.state.sessions.size === n
        && document.querySelector('#terminal-status').textContent === '会话中', i)
    }
    await page.fill('#compose', '当前会话草稿保持不变')
    await page.evaluate(() => {
      window.__mobileFixture.setTitle('mobile-1', '拉取代码并本地打包 | QingCode')
      window.__mobileFixture.setTitle('mobile-2', '临时终端')
      window.__mobileFixture.setTitle('mobile-3', '修复 CTRL+C 显示不全 | QingCode')
    })
    await drawer()
    await page.waitForFunction(() => document.querySelector('#session-options').textContent.includes('修复 CTRL+C'))
    await step('drawer actions remain visible at narrow, portrait, keyboard and landscape sizes', async () => {
      for (const [width, height] of [[390, 844], [320, 640], [390, 400], [844, 390]]) {
        await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, mobile: true, deviceScaleFactor: 1 })
        await page.evaluate(wide => window.qingOrientation(wide), width > 600)
        await page.waitForFunction(w => innerWidth === w, width)
        const layout = await page.evaluate(() => {
          const drawer = document.querySelector('#session-drawer').getBoundingClientRect()
          const actions = [...document.querySelectorAll('.session-close, .session-more')].map(button => {
            const box = button.getBoundingClientRect()
            return box.width >= 44 && box.height >= 44 && box.right <= drawer.right
          })
          return { actions, overflow: document.documentElement.scrollWidth > innerWidth,
            footer: document.querySelector('#end-all-sessions').getBoundingClientRect().bottom <= innerHeight,
            count: document.querySelector('#session-count').textContent }
        })
        assert.ok(layout.actions.every(Boolean) && !layout.overflow && layout.footer, JSON.stringify(layout))
        assert.equal(layout.count, '3')
        await page.screenshot({ path: resolve(output, `drawer-${width}x${height}.png`) })
      }
      await page.cdp('Emulation.clearDeviceMetricsOverride')
      await page.evaluate(() => window.qingOrientation(false))
    })
    await step('cancel names the selected target and keeps all sessions', async () => {
      await page.click(row('mobile-2') + ' .session-close')
      await page.waitForSelector('#confirm-dialog[open]')
      assert.match(await page.evaluate(() => document.querySelector('#confirm-text').textContent), /临时终端/)
      await page.click('#confirm-dialog [value="cancel"]')
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), [])
      assert.equal(await page.evaluate(() => document.querySelector('#session-options [aria-current="true"]').closest('.session-option').dataset.id), 'mobile-3')
    })
    await step('closing another terminal keeps the current selection, output and draft', async () => {
      await close('mobile-2')
      await count(2)
      assert.equal(await page.evaluate(() => document.querySelector('#session-options [aria-current="true"]').closest('.session-option').dataset.id), 'mobile-3')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '当前会话草稿保持不变')
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), ['mobile-2'])
    })
    await step('failed close keeps the session and exposes an error with retry available', async () => {
      await page.evaluate(() => window.__mobileFixture.state.endErrors.add('mobile-3'))
      await close('mobile-3')
      assert.match(await page.evaluate(() => document.querySelector('#session-error').textContent), /模拟结束失败/)
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '当前会话草稿保持不变')
      await count(2)
      await page.evaluate(() => window.__mobileFixture.state.endErrors.clear())
    })
    await step('closing the current terminal resumes the remaining terminal and its draft', async () => {
      await close('mobile-3')
      await count(1)
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '第一会话的草稿')
      assert.equal(await page.evaluate(() => document.querySelector('#session-options [data-current="true"]').dataset.id), 'mobile-1')
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
    })
    await step('closing the last session returns to the home page', async () => {
      await close('mobile-1')
      await page.waitForFunction(() => document.querySelector('#terminal-screen').hidden && !document.querySelector('#home-screen').hidden)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.sessions.size), 0)
    })
    if (regression) {
      await sidebarRegression({ spaceId: task.spaceId, artifactDir: resolve(output, 'sidebar-regression'), finish: false })
      results.push({ name: 'rename, session status, legacy desktop and batch-close scope, cancellation, failure and retry regression', passed: true })
    }
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
