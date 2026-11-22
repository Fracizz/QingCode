import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 手机端预热标志：领取了预热终端的会话在侧栏「本项目」「全部」行和终端顶栏标题旁显示 ⚡，
// 电脑上开的预热终端也一样。只操作内存桥中的会话；真实预热领取由 Rust / 电脑端测试覆盖。
export async function run({ spaceId, finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-prewarm-badge')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode prewarm badge 20261122')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const settled = selector => page.waitForFunction(target => {
    const node = document.querySelector(target)
    return node.open && !node.getAnimations().some(animation => animation.playState === 'running')
  }, selector)
  const scope = async value => {
    await page.click(`[data-scope="${value}"]`)
    await page.waitForFunction(all => document.querySelector('#session-options').hidden === all, value === 'all')
  }
  // 标志是否可见，以及与标题首行是否垂直居中。
  const mark = (root, id) => page.evaluate(([root, id]) => {
    const row = document.querySelector(`${root} [data-id="${id}"]`)
    const icon = row?.querySelector('.session-prewarm')
    if (!icon) return null
    const box = icon.getBoundingClientRect()
    const label = row.querySelector('.session-label').getBoundingClientRect()
    return { visible: box.width > 0 && box.height > 0, label: icon.getAttribute('aria-label'), right: box.left >= label.right - 1 }
  }, [root, id])
  // <svg> 没有 hidden 属性接口，按实际渲染尺寸判断是否可见。
  const headerMark = () => page.evaluate(() => document.querySelector('#terminal-prewarm').getBoundingClientRect().width > 0)
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
    await page.evaluate(() => window.qingOrientation(false))
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list > :first-child .project-row:first-child .row')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    const seeded = await page.evaluate(() => {
      const fixture = window.__mobileFixture
      return {
        warm: fixture.addSession({ project: 'p-local', title: 'Codex', prewarm: true }),
        desktop: fixture.addDesktopTerminal({ id: 'desktop-warm', project: 'p-local', title: 'Claude', prewarm: true }).id,
      }
    })
    await page.click('#show-sessions')
    await settled('#session-drawer')
    await page.waitForFunction(id => document.querySelector(`#session-options [data-id="${id}"]`), seeded.warm)

    await step('project scope shows the bolt only on prewarmed sessions', async () => {
      const warm = await mark('#session-options', seeded.warm)
      assert.deepEqual(warm, { visible: true, label: '已领取预热终端', right: true })
      assert.equal((await mark('#session-options', 'mobile-1')).visible, false)
      assert.equal(await headerMark(), false)
      await page.screenshot({ path: resolve(output, 'project-390.png') })
    })

    await step('all scope shows the bolt on prewarmed phone and desktop terminals', async () => {
      await scope('all')
      await page.waitForFunction(id => document.querySelector(`#session-overview [data-id="${id}"]`), seeded.desktop)
      assert.equal((await mark('#session-overview', seeded.warm)).visible, true)
      assert.equal((await mark('#session-overview', seeded.desktop)).visible, true)
      assert.equal((await mark('#session-overview', 'mobile-1')).visible, false)
      await page.screenshot({ path: resolve(output, 'all-390.png') })
    })

    await step('the terminal header shows the bolt after switching to a prewarmed desktop terminal', async () => {
      await page.click(`#session-overview [data-id="${seeded.desktop}"] .row`)
      await page.waitForFunction(() => document.querySelector('#terminal-prewarm').getBoundingClientRect().width > 0)
      await page.screenshot({ path: resolve(output, 'desktop-header-390.png') })
    })

    await step('the header hides the bolt again on a regular session', async () => {
      await page.click('#show-sessions')
      await settled('#session-drawer')
      await scope('project')
      await page.click('#session-options [data-id="mobile-1"] .row')
      await page.waitForFunction(() => document.querySelector('#terminal-prewarm').getBoundingClientRect().width === 0)
      await page.click('#show-sessions')
      await settled('#session-drawer')
      await page.click(`#session-options [data-id="${seeded.warm}"] .row`)
      await page.waitForFunction(() => document.querySelector('#terminal-prewarm').getBoundingClientRect().width > 0)
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
