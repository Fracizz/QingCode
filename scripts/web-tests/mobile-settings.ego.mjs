// 安卓设置页 Web 验收：入口、通用设置归位、就地切换语言、返回键层级、偏好重载后保留、窄屏与横屏布局。
// 使用真实 Web 资产和内存桥，不替代 Android 真机验收。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-settings')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile settings 20261106')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const shots = []
  const shot = async name => {
    try { await page.screenshot({ path: resolve(output, name) }); shots.push(name) } catch (error) { shots.push(name + ' (skipped: ' + error.name + ')') }
  }
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const metrics = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
  const isOpen = id => page.evaluate(value => document.getElementById(value).open, id)
  const settled = id => page.waitForFunction(value => !document.getElementById(value).getAnimations().some(animation => animation.playState === 'running'), id)
  const openFromHome = async () => {
    await page.click('#open-settings', { label: 'open settings' })
    await page.waitForSelector('#settings-dialog[open]')
    await settled('settings-dialog')
  }
  const noOverflow = () => page.evaluate(() => {
    const dialog = document.querySelector('#settings-dialog').getBoundingClientRect()
    const cards = [...document.querySelectorAll('#settings-dialog .settings-body > :not(p, h3)')].map(item => item.getBoundingClientRect())
    return dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight
      && cards.every(card => card.left >= dialog.left && card.right <= dialog.right)
      && document.querySelector('#settings-dialog .settings-body').scrollWidth <= document.querySelector('#settings-dialog .settings-body').clientWidth
  })
  try {
    await metrics(390, 844)
    await page.goto(baseUrl + '/mobile-android/?lang=zh')
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await metrics(390, 844)
    await page.waitForFunction(() => typeof window.qingLink === 'function')

    await step('工作台顶栏提供设置入口，通用设置不再散落在连接页和终端设置', async () => {
      await page.waitForFunction(() => document.querySelector('#open-settings').getBoundingClientRect().height >= 44)
      assert.ok(await page.evaluate(() => {
        const inSettings = ['app-language', 'update-section', 'keep-screen-on', 'image-compression', 'send-mode', 'session-watch', 'terminal-renderer']
          .every(id => document.getElementById(id).closest('#settings-dialog'))
        const inTerminal = ['terminal-columns', 'touch-mode', 'font-size', 'open-key-layout', 'open-settings-from-terminal']
          .every(id => document.getElementById(id).closest('#session-dialog'))
        return inSettings && inTerminal && !document.querySelector('#connection-screen #app-language')
      }))
      assert.equal(await page.evaluate(() => document.querySelectorAll('#dashboard-nav button').length), 3)
    })
    await step('设置页铺满屏幕，返回键先关闭设置页并留在原页面', async () => {
      await page.click('#dashboard-nav [data-page="connection"]', { label: 'open connections page' })
      await openFromHome()
      assert.ok(await page.evaluate(() => document.querySelector('#settings-dialog').getBoundingClientRect().width >= innerWidth - 20))
      assert.ok(await noOverflow())
      await shot('settings-390.png')
      assert.equal(await page.evaluate(() => window.qingBack()), true)
      assert.equal(await isOpen('settings-dialog'), false)
      assert.equal(await page.evaluate(() => document.querySelector('#connection-screen').hidden), false)
    })
    await step('在设置页切换语言立即生效且设置页保持打开', async () => {
      await openFromHome()
      await page.click('#app-language [data-locale="en"]', { label: 'choose English' })
      await page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('#settings-title').textContent === 'Settings')
      assert.equal(await isOpen('settings-dialog'), true)
      assert.equal(await page.evaluate(() => document.querySelector('#open-settings').getAttribute('aria-label')), 'Open settings')
      await shot('settings-en.png')
      await page.click('#app-language [data-locale="zh"]', { label: 'choose Chinese' })
      await page.waitForFunction(() => document.documentElement.lang === 'zh-CN' && document.querySelector('#settings-title').textContent === '设置')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:locale')), 'zh')
    })
    await step('屏幕常亮默认关闭，切换后通知原生层，重载后恢复', async () => {
      const requests = () => page.evaluate(() => window.__mobileFixture.state.keepScreenOnRequests ?? [])
      assert.equal(await page.evaluate(() => document.querySelector('#keep-screen-on').value), 'off')
      assert.deepEqual(await requests(), [])
      await page.selectOption('#keep-screen-on', 'on')
      await page.waitForFunction(() => window.__mobileFixture.state.keepScreenOnRequests?.length === 1)
      assert.deepEqual(await requests(), [true])
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:keep-screen-on')), 'on')
      await page.reload()
      await metrics(390, 844)
      await page.waitForFunction(() => typeof window.qingLink === 'function')
      await page.waitForFunction(() => window.__mobileFixture.state.keepScreenOnRequests?.length === 1)
      assert.equal(await page.evaluate(() => document.querySelector('#keep-screen-on').value), 'on')
      assert.deepEqual(await requests(), [true])
      await openFromHome()
      await page.selectOption('#keep-screen-on', 'off')
      await page.waitForFunction(() => window.__mobileFixture.state.keepScreenOnRequests?.length === 2)
      assert.deepEqual(await requests(), [true, false])
    })
    await step('未打开终端时也能修改图片压缩和发送按键，重载后保留', async () => {
      await page.selectOption('#image-compression', 'high')
      await page.selectOption('#send-mode', 'enter')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:image-compression')), 'high')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:send-mode')), 'enter')
      await page.click('#settings-dialog [data-close]', { label: 'close settings' })
      assert.equal(await isOpen('settings-dialog'), false)
      await page.reload()
      await metrics(390, 844)
      await page.waitForFunction(() => typeof window.qingLink === 'function')
      assert.equal(await page.evaluate(() => document.querySelector('#image-compression').value), 'high')
      assert.equal(await page.evaluate(() => document.querySelector('#send-mode').value), 'enter')
    })
    await step('窄屏和横屏不溢出，长连接名不挤掉设置入口', async () => {
      await page.waitForFunction(() => typeof window.qingLink === 'function')
      await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
      await page.waitForSelector('#pair-dialog[open]')
      await page.fill('#pair-name', '这是一台名字特别特别特别特别长的工作电脑')
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit', { label: 'pair fixture computer' })
      await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
      await metrics(320, 640)
      assert.ok(await page.evaluate(() => {
        const gear = document.querySelector('#open-settings').getBoundingClientRect()
        const pill = document.querySelector('#active-host').getBoundingClientRect()
        const brand = document.querySelector('.brand').getBoundingClientRect()
        return gear.right <= innerWidth && gear.width >= 44 && pill.right <= gear.left && pill.left >= brand.right && pill.width > 60
      }))
      await shot('home-320.png')
      await openFromHome()
      assert.ok(await noOverflow())
      await page.evaluate(() => { const body = document.querySelector('.settings-body'); body.scrollTop = body.scrollHeight })
      assert.ok(await page.evaluate(() => document.querySelector('#terminal-renderer-hint').getBoundingClientRect().bottom <= document.querySelector('.settings-body').getBoundingClientRect().bottom + 1))
      await shot('settings-320-bottom.png')
      await metrics(780, 360)
      assert.ok(await noOverflow())
      await shot('settings-landscape.png')
      await page.click('#settings-dialog [data-close]', { label: 'close settings' })
      await metrics(390, 844)
    })
    await step('终端设置可进入设置页，返回逐层回到终端且会话不中断', async () => {
      await page.click('#dashboard-nav [data-page="project"]', { label: 'show project list' })
      await page.click('#project-list .row:first-child', { label: 'open fixture project' })
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await page.click('#manage-sessions', { label: 'open terminal settings' })
      await page.waitForSelector('#session-dialog[open]')
      await settled('session-dialog')
      await shot('terminal-settings.png')
      await page.click('#open-settings-from-terminal', { label: 'open settings from terminal' })
      await page.waitForSelector('#settings-dialog[open]')
      await settled('settings-dialog')
      await page.selectOption('#send-mode', 'default')
      await page.evaluate(() => window.qingBack())
      assert.equal(await isOpen('settings-dialog'), false)
      assert.equal(await isOpen('session-dialog'), true)
      await page.evaluate(() => window.qingBack())
      assert.equal(await isOpen('session-dialog'), false)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-screen').hidden), false)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-status').textContent), '会话中')
      await page.fill('#compose', '/effort')
      await page.waitForFunction(() => document.querySelector('#send-label').textContent === '候选')
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, results, shots }, null, 2))
    await task.finish({ keep: [] })
    console.log(JSON.stringify({ output, results, shots }, null, 2))
  } catch (error) {
    results.push({ passed: false, error: String(error?.stack ?? error) })
    await shot('failure.png')
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, spaceId: task.spaceId, results, shots }, null, 2))
    console.log(JSON.stringify({ output, results, shots }, null, 2))
    throw error
  }
}
