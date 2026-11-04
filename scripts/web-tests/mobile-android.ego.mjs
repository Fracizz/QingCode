import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// QingCode Android WebView 验收：真实 index.html / app.js / protocol.js / xterm，
// MainActivity 与 Windows RPC 由 web-tests/mobile-android-bridge.js 内存模拟。
export async function run({ spaceId, artifactDir, screenshots = true, baseUrl = 'http://127.0.0.1:38439' } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `mobile-android-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode Android companion 20261103')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => {
    await work()
    results.push({ name, status: 'passed' })
  }
  const terminalText = () => page.evaluate(() => window.__mobileFixture.terminalText())
  const inputs = () => page.evaluate(() => window.__mobileFixture.state.inputs)
  // The key bar scrolls horizontally on phones; bring a key into view before tapping it.
  const tapKey = async key => {
    const advanced = ['alt', 'ctrl', 'home', 'end', 'pgup', 'pgdn'].includes(key)
    if (advanced && !await page.evaluate(() => document.querySelector('#keys-dialog').open)) await page.click('#more-keys')
    if (!advanced && await page.evaluate(() => document.querySelector('#keys-dialog').open)) await page.evaluate(() => window.qingBack())
    await page.evaluate(name => document.querySelector(`[data-key="${name}"]`).scrollIntoView({ inline: 'center', block: 'nearest' }), key)
    await page.click(`[data-key="${key}"]`, { label: `tap ${key} key` })
  }
  const text = selector => page.evaluate(target => document.querySelector(target)?.textContent ?? '', selector)
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(`${baseUrl}/mobile-android/`)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => document.getElementById('home-empty-title')?.textContent === '连接一台 QingCode')

    await step('pasted pairing link fills the form and skips manual fingerprint comparison', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.clipboard = window.__mobileFixture.link('192.168.1.8', 48764) })
      await page.click('#chat-empty-action', { label: 'add first connection' })
      await page.waitForSelector('#pair-dialog[open]')
      await page.click('#pair-paste', { label: 'paste pairing link' })
      await page.waitForFunction(() => !document.getElementById('pair-link-state').hidden)
      assert.deepEqual(await page.evaluate(() => [
        document.getElementById('pair-name').value,
        document.getElementById('pair-host').value,
        document.getElementById('pair-port').value,
      ]), ['DEVBOX', '192.168.1.8', '48764'])
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit', { label: 'pair with desktop' })
      await page.waitForFunction(() => document.getElementById('active-host-name').textContent === 'DEVBOX'
        && document.getElementById('active-host').dataset.state === 'online')
      assert.equal(await page.evaluate(() => document.getElementById('pair-confirm').open), false)
      const pairs = await page.evaluate(() => window.__mobileFixture.state.pairs)
      assert.equal(pairs.at(-1).fingerprint, '0123456789abcdef'.repeat(4))
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'home-paired.png') })

    await step('a host whose certificate differs from the QR fingerprint is refused before the code is sent', async () => {
      await page.click('loc=role:button[name="连接"]', { label: 'open connections page' })
      await page.click('#add-host', { label: 'add another connection' })
      await page.waitForSelector('#pair-dialog[open]')
      await page.evaluate(() => { window.__mobileFixture.state.clipboard = window.__mobileFixture.link('10.0.0.9', 48764) })
      await page.click('#pair-paste', { label: 'paste spoofed link' })
      // Pasting resets the form asynchronously; type the code only after it lands.
      await page.waitForFunction(() => document.getElementById('pair-host').value === '10.0.0.9')
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit', { label: 'try spoofed pairing' })
      await page.waitForFunction(() => /指纹不一致/.test(document.getElementById('pair-error').textContent))
      const pairs = await page.evaluate(() => window.__mobileFixture.state.pairs.map(item => item.id))
      assert.ok(!pairs.includes('10.0.0.9:48764'))
      await page.click('#pair-dialog [data-close]', { label: 'cancel pairing' })
    })

    await step('a deep link opens prefilled pairing', async () => {
      await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 49000, '0123456789abcdef'.repeat(4), '新电脑')))
      await page.waitForSelector('#pair-dialog[open]')
      assert.deepEqual(await page.evaluate(() => [
        document.getElementById('pair-name').value,
        document.getElementById('pair-port').value,
        document.getElementById('pair-link-state').hidden,
      ]), ['新电脑', '49000', false])
      await page.click('#pair-dialog [data-close]', { label: 'dismiss deep link' })
      await page.evaluate(() => window.qingLink('https://example.com'))
      await page.waitForFunction(() => /不是 QingCode 配对链接/.test(document.getElementById('connection-error').textContent))
    })

    await step('opening a project starts a terminal and the command bar submits a line', async () => {
      await page.click('loc=role:button[name="项目"]', { label: 'open project list' })
      await page.click('loc=role:button[name*="QingCode 本机"]', { label: 'open QingCode project' })
      await page.waitForFunction(() => document.getElementById('terminal-status').textContent === '会话中')
      assert.match(await terminalText(), /PS D:\\code\\qingcode>/)
      await page.fill('#compose', 'git status')
      await page.click('#send', { label: 'send command' })
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('git status\r'))
      await page.waitForFunction(() => /ok/.test(window.__mobileFixture.terminalText()))
    })

    await step('a daemon screen snapshot renders as text and polling continues', async () => {
      await page.evaluate(() => window.__mobileFixture.pushScreen('mobile-1', '\x1b[2J\x1b[HSNAPSHOT-READY\r\n$ ', 80, 24))
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('SNAPSHOT-READY'))
      await page.waitForTimeout(1500)
      assert.equal(await text('#terminal-status'), '会话中')
      await page.fill('#compose', 'echo after')
      await page.click('#send', { label: 'send after snapshot' })
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('echo after'))
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'terminal.png') })

    await step('Alt, Home and PgUp keys send terminal sequences', async () => {
      await tapKey('alt')
      assert.equal(await page.evaluate(() => document.querySelector('#keys-dialog [data-key="alt"]').getAttribute('aria-pressed')), 'true')
      await tapKey('left')
      await tapKey('home')
      await tapKey('pgup')
      await page.evaluate(() => window.qingBack())
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.join('').includes('\x1b[5~'))
      const sent = (await inputs()).join('')
      assert.ok(sent.includes('\x1b\x1b[D\x1b[H\x1b[5~'), JSON.stringify(sent))
      assert.equal(await page.evaluate(() => document.querySelector('#keys-dialog [data-key="alt"]').getAttribute('aria-pressed')), 'false')
    })

    await step('changing the port keeps the pairing and moves per-connection records', async () => {
      await page.click('#show-sessions', { label: 'open session drawer' })
      await page.waitForSelector('#session-drawer[open]')
      await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
      await page.click('#back', { label: 'return to dashboard' })
      await page.click('loc=role:button[name="连接"]', { label: 'open connections page' })
      await page.click('loc=role:button[name="管理连接 DEVBOX"]', { label: 'manage DEVBOX connection' })
      await page.fill('#host-port', '49000')
      await page.click('#host-form [type="submit"]', { label: 'save new port' })
      await page.waitForFunction(() => document.getElementById('connection-list').textContent.includes('192.168.1.8:49000'))
      await page.waitForFunction(() => document.getElementById('active-host').dataset.state === 'online')
      const keys = await page.evaluate(() => Object.keys(localStorage).sort())
      assert.ok(keys.includes('qingcode:mobile:project:192.168.1.8:49000'), keys.join(','))
      assert.ok(!keys.some(key => key.includes('192.168.1.8:48764')), keys.join(','))
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:active')), '192.168.1.8:49000')
    })

    await step('resume card reopens the same session on the new address', async () => {
      await page.click('#dashboard-nav [data-page="chat"]', { label: 'show chats' }).then(() => page.click('#chat-terminals', { label: 'open home page' }))
      await page.click('#resume', { label: 'resume last terminal' })
      await page.waitForFunction(() => document.getElementById('terminal-status').textContent === '会话中')
      assert.match(await terminalText(), /echo after/)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'terminal-resumed.png') })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, nativeAndroid: false, screenshots }, null, 2))
    console.log({ output, results })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, spaceId: task.spaceId, results })
    throw error
  }
}
