import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 手机「新建会话」选项来自电脑端终端配置：列表、信任提示、按 id 创建、旧电脑兼容。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-terminal-profiles')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile terminal profiles 20261104')
  const page = task.page('p1')
  const results = []
  const step = async (name, action) => { await action(); results.push({ name, passed: true }) }
  const state = expression => page.evaluate(expression)
  const choices = () => state(() => [...document.querySelectorAll('#terminal-profiles button')]
    .map(button => [button.dataset.profile ?? null, button.querySelector('span').textContent]))
  const openDialog = async label => {
    await page.click('#new-session', { label })
    await page.waitForSelector('#new-session-dialog[open]')
  }
  const sessionCount = () => state(() => window.__mobileFixture.state.sessions.size)
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/')
    // 只清理本 fixture 页面的应用记录。
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await page.waitForFunction(() => !!window.__mobileFixture && typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.waitForSelector('#pair-dialog[open]')
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'open project list' })
    await page.click('#project-list .row:first-child', { label: 'open local project' })
    await page.click('#terminal-empty-new', { label: 'open new session dialog from empty state' })
    await page.waitForFunction(() => document.querySelector('#new-session-dialog').open
      && document.querySelector('#terminal-profiles').getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('#terminal-profiles button').length === 4)
    await step('the empty-state button opens the same new-session choices', async () => {
      assert.deepEqual(await choices(), [['default', '普通终端'], ['claude', 'Claude'], ['opencode', 'OpenCode'], ['deploy', '部署']])
    })
    await page.click('#new-session-dialog [data-profile="default"]', { label: 'start default profile from empty state' })
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')

    await step('the first terminal is created from the desktop default profile', async () => {
      assert.deepEqual(await state(() => window.__mobileFixture.state.creates), [{ project: 'p-local', terminalProfile: 'default' }])
    })
    await step('new-session choices list the desktop profiles with trust hints', async () => {
      await openDialog('open new session dialog')
      await page.waitForFunction(() => document.querySelector('#terminal-profiles').getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('#terminal-profiles button').length === 4)
      assert.deepEqual(await choices(), [['default', '普通终端'], ['claude', 'Claude'], ['opencode', 'OpenCode'], ['deploy', '部署']])
      assert.equal(await state(() => document.querySelector('[data-profile="deploy"] small')?.textContent), '需先在电脑上信任')
      assert.ok(await state(() => document.querySelector('#new-session-dialog').textContent.includes('设置 → 终端 → 终端配置')))
      assert.ok(await state(() => document.documentElement.scrollWidth <= innerWidth))
    })
    await page.screenshot({ path: resolve(output, 'profiles.png') })
    await step('an untrusted profile stays in the dialog and creates nothing', async () => {
      const before = await sessionCount()
      await page.click('#new-session-dialog [data-profile="deploy"]', { label: 'choose untrusted profile' })
      await page.waitForFunction(() => !document.querySelector('#terminal-profiles-error').hidden)
      assert.match(await state(() => document.querySelector('#terminal-profiles-error').textContent), /「部署」.*信任此配置/)
      assert.equal(await state(() => document.querySelector('#new-session-dialog').open), true)
      assert.equal(await sessionCount(), before)
    })
    await page.screenshot({ path: resolve(output, 'untrusted.png') })
    await step('a trusted profile creates one session by id without typing a command', async () => {
      const inputs = await state(() => window.__mobileFixture.state.inputs.length)
      await page.click('#new-session-dialog [data-profile="claude"]', { label: 'start Claude profile' })
      await page.waitForFunction(() => window.__mobileFixture.state.sessions.size === 2
        && !document.querySelector('#new-session-dialog').open
        && document.querySelector('#terminal-status').textContent === '会话中')
      assert.deepEqual(await state(() => window.__mobileFixture.state.creates.at(-1)), { project: 'p-local', terminalProfile: 'claude' })
      assert.equal(await state(() => window.__mobileFixture.state.inputs.length), inputs)
    })
    await step('edited desktop profiles appear the next time the dialog opens', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.terminalProfiles = [{ id: 'default', name: '普通终端', trusted: true }, { id: 'build', name: '构建', trusted: true }] })
      await openDialog('reopen new session dialog')
      await page.waitForFunction(() => document.querySelector('[data-profile="build"]'))
      assert.deepEqual(await choices(), [['default', '普通终端'], ['build', '构建']])
      await page.click('#new-session-dialog [data-profile="build"]', { label: 'start build profile' })
      await page.waitForFunction(() => window.__mobileFixture.state.sessions.size === 3)
      assert.equal(await state(() => window.__mobileFixture.state.creates.at(-1).terminalProfile), 'build')
    })
    await step('a profile removed on the desktop reports the desktop error', async () => {
      const requests = await state(() => window.__mobileFixture.state.terminalProfileRequests)
      await openDialog('open dialog with stale profile')
      await page.waitForFunction(count => window.__mobileFixture.state.terminalProfileRequests > count
        && document.querySelector('[data-profile="build"]'), requests)
      // 计数在 fixture 收到请求时增加；留出回包渲染的时间。
      await new Promise(done => setTimeout(done, 100))
      // 列表刷新后电脑端又删除了该配置：创建请求由电脑端拒绝。
      await page.evaluate(() => { window.__mobileFixture.state.terminalProfiles = [{ id: 'default', name: '普通终端', trusted: true }] })
      await page.click('#new-session-dialog [data-profile="build"]', { label: 'start removed profile' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent.includes('不存在'))
      assert.equal(await sessionCount(), 3)
    })
    await step('older desktops without profile support keep a plain terminal option', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.terminalProfiles = null })
      // 另一台电脑地址没有缓存：模拟首次连接不支持终端配置的旧版电脑。
      await page.click('#show-sessions', { label: 'open session drawer' })
      await page.waitForFunction(() => document.querySelector('#session-drawer').open
        && !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
      await page.click('#back', { label: 'leave terminal' })
      await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 49000, undefined, '旧电脑')))
      await page.waitForSelector('#pair-dialog[open]')
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit', { label: 'pair legacy computer' })
      await page.waitForFunction(() => document.querySelector('#active-host-name').textContent === '旧电脑'
        && document.querySelector('#active-host').dataset.state === 'online')
      await page.click('#dashboard-nav [data-page="project"]', { label: 'open legacy project list' })
      await page.click('#project-list .row:first-child', { label: 'open legacy project' })
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await openDialog('open dialog on legacy desktop')
      await page.waitForFunction(() => !document.querySelector('#terminal-profiles-error').hidden)
      assert.deepEqual(await choices(), [[null, '新建终端']])
      const before = await sessionCount()
      await page.click('#terminal-profiles button', { label: 'start plain terminal on legacy desktop' })
      await page.waitForFunction(count => window.__mobileFixture.state.sessions.size === count + 1, before)
      assert.equal(await state(() => window.__mobileFixture.state.creates.at(-1).terminalProfile), null)
    })
    await page.screenshot({ path: resolve(output, 'legacy.png') })
    await step('the dialog fits a 320px screen', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.terminalProfiles = [
        { id: 'default', name: '普通终端', trusted: true },
        { id: 'long', name: '非常长的终端配置名称用于检查窄屏换行与按钮高度是否正常显示', trusted: false },
      ] })
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
      await openDialog('open dialog on narrow screen')
      await page.waitForFunction(() => document.querySelector('[data-profile="long"]'))
      assert.ok(await state(() => [...document.querySelectorAll('#terminal-profiles button')].every(button => {
        const bounds = button.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.height >= 44
      }) && document.documentElement.scrollWidth <= innerWidth))
    })
    await page.screenshot({ path: resolve(output, 'narrow.png') })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
    throw error
  }
}
