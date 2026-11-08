import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 真实 Web 资产和输入队列；原生桥由 fixture 模拟，含延迟、失败与会话切换。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = resolve(repo, '.dev/web-tests/mobile-send-settings')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode send settings 20261104')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const metrics = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
  const settings = async () => {
    await page.cdp('Emulation.clearDeviceMetricsOverride')
    await page.evaluate(() => window.qingOrientation(false))
    if (await page.evaluate(() => document.querySelector('#terminal-menu').getBoundingClientRect().height > 0)) {
      await page.click('#terminal-menu', { label: 'open terminal menu' })
      await page.waitForSelector('#terminal-menu-dialog[open]')
      await page.click('#manage-sessions', { label: 'open terminal settings' })
    } else {
      await page.click('#terminal-menu', { label: 'open fullscreen terminal menu' })
      await page.click('#menu-sessions', { label: 'open terminal sessions' })
      await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
      await page.click('#drawer-settings', { label: 'open terminal settings' })
    }
    await page.waitForSelector('#session-dialog[open]')
    await page.waitForFunction(() => !document.querySelector('#session-dialog').getAnimations().some(animation => animation.playState === 'running'))
  }
  const closeSettings = async () => {
    await page.cdp('Emulation.clearDeviceMetricsOverride')
    await page.click('#session-dialog [data-close]', { label: 'close terminal settings' })
  }
  // 发送按键在「设置」页：从终端设置进入，改完直接回到终端设置。
  const selectSendMode = async value => {
    await page.click('#open-settings-from-terminal', { label: 'open settings' })
    await page.waitForSelector('#settings-dialog[open]')
    await page.selectOption('#send-mode', value)
    await page.click('#settings-dialog [data-close]', { label: 'close settings' })
  }
  const resetInputs = () => page.evaluate(() => {
    const state = window.__mobileFixture.state
    state.inputs = []; state.inputEvents = []; state.inputError = ''; state.inputDelay = 0
  })
  const send = async text => { await page.fill('#compose', text); await page.click('#send', { label: 'submit terminal draft' }) }
  const enterReceived = () => page.waitForFunction(() => window.__mobileFixture.state.inputEvents?.some(event => event.data === '\r' && event.receivedAt))
  try {
    await metrics(390, 844)
    await page.goto(baseUrl + '/mobile-android/')
    await page.snapshot()
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'browse fixture projects' })
    await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'open terminal project' })
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await step('shortcut labels fit at 320px, 390px, keyboard height and landscape', async () => {
      for (const [width, height, name] of [[390, 844, 'portrait'], [320, 640, 'narrow'], [390, 400, 'keyboard'], [844, 390, 'landscape']]) {
        await metrics(width, height)
        await page.evaluate(value => window.qingOrientation(value), width > 600)
        if (await page.evaluate(() => document.querySelector('#toggle-keys').getAttribute('aria-expanded') === 'false')) await page.click('#toggle-keys')
        const fit = await page.evaluate(() => {
          const button = document.querySelector('#special-keys [data-key="interrupt"]')
          const box = button.getBoundingClientRect()
          const text = document.createRange(); text.selectNodeContents(button)
          const label = text.getBoundingClientRect()
          return { text: button.textContent, accessibleName: button.getAttribute('aria-label'),
            fits: label.left >= box.left + 4 && label.right <= box.right - 4, width: box.width, height: box.height,
            keysLargeEnough: [...document.querySelectorAll('#special-keys > button')].every(key => key.getBoundingClientRect().width >= 44),
            overflow: document.documentElement.scrollWidth > innerWidth }
        })
        assert.equal(fit.text, '^C')
        assert.equal(fit.accessibleName, '发送 Ctrl+C')
        assert.ok(fit.fits && fit.height >= 44 && fit.keysLargeEnough && !fit.overflow, JSON.stringify(fit))
        await page.screenshot({ path: resolve(output, name + '.png') })
      }
      await metrics(390, 844)
      await page.evaluate(() => window.qingOrientation(false))
    })
    await step('touch options use readable rows and settings apply immediately', async () => {
      await settings()
      await page.click('#touch-mode label:last-of-type', { label: 'send touches to program' })
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:touch-mode')), 'program')
      await selectSendMode('enter')
      await metrics(390, 844)
      await page.evaluate(() => { document.querySelector('#session-dialog').scrollTop = 0 })
      await page.screenshot({ path: resolve(output, 'settings.png') })
      await closeSettings()
      await page.fill('#compose', '/effort')
      assert.equal(await page.evaluate(() => document.querySelector('#send-label').textContent), '发送')
      assert.equal(await page.evaluate(() => document.querySelector('#send').getAttribute('aria-label')), '发送并回车')
    })
    await step('slow input waits for acknowledgement plus a gap before Enter', async () => {
      await resetInputs()
      await page.evaluate(() => { window.__mobileFixture.state.inputDelay = 450 })
      await send('/effort')
      await enterReceived()
      const events = await page.evaluate(() => window.__mobileFixture.state.inputEvents)
      assert.deepEqual(events.map(event => event.data), ['/effort', '\r'])
      assert.ok(events[1].startedAt - events[0].receivedAt >= 200, JSON.stringify(events))
      await resetInputs()
    })
    await step('a later submission cannot interleave before the first Enter', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.inputDelay = 250 })
      await send('first')
      await send('second')
      await page.waitForFunction(() => window.__mobileFixture.state.inputEvents?.filter(event => event.data === '\r' && event.receivedAt).length === 2)
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['first', '\r', 'second', '\r'])
      await resetInputs()
    })
    await step('failed text never sends Enter and its receipt is unknown', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.inputError = '模拟输入失败' })
      await send('must-not-execute')
      await page.waitForFunction(() => /未知/.test(document.querySelector('#submission-state').textContent))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['must-not-execute'])
      await resetInputs()
      // A successful command is a queue barrier: a delayed Enter from the failed command would precede it.
      await send('after-error')
      await enterReceived()
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['after-error', '\r'])
      await resetInputs()
    })
    await step('leaving the terminal before acknowledgement cancels its delayed Enter', async () => {
      await page.evaluate(() => {
        window.__mobileFixture.state.inputGate = new Promise(resolve => { window.__releaseInput = resolve })
      })
      await send('cancelled-enter')
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('cancelled-enter'))
      await page.evaluate(() => window.qingBack())
      await page.evaluate(() => { window.__mobileFixture.state.inputGate = null; window.__releaseInput() })
      await page.click('#dashboard-nav [data-page="project"]', { label: 'return to fixture projects' })
      await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'resume previous terminal' })
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await send('queue-barrier')
      await enterReceived()
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['cancelled-enter', 'queue-barrier', '\r'])
      await resetInputs()
    })
    await step('send and touch preferences survive reload; default slash still previews', async () => {
      await page.reload()
      // fixture 的原生配对和会话只在内存中；重新配对，不清除 Web 设置。
      await page.waitForFunction(() => typeof window.qingLink === 'function')
      await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit', { label: 'pair fixture after reload' })
      await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
      if (await page.evaluate(() => document.querySelector('#terminal-screen').hidden)) {
        await page.click('#dashboard-nav [data-page="project"]', { label: 'browse projects after reload' })
        await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'resume after page reload' })
        await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      }
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await settings()
      assert.equal(await page.evaluate(() => document.querySelector('#send-mode').value), 'enter')
      assert.equal(await page.evaluate(() => document.querySelector('#touch-mode input:checked').value), 'program')
      await closeSettings()
      await send('reloaded')
      await enterReceived()
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['reloaded', '\r'])
      await resetInputs()
      await settings()
      await selectSendMode('default')
      await closeSettings()
      await page.fill('#compose', '/effort')
      assert.equal(await page.evaluate(() => document.querySelector('#send-label').textContent), '候选')
      await page.click('#send', { label: 'preview slash candidates' })
      await page.waitForFunction(() => window.__mobileFixture.state.inputEvents?.some(event => event.receivedAt))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['/effort'])
      await page.fill('#compose', 'echo default')
      await page.click('#send', { label: 'submit default command' })
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('echo default\r'))
    })
    await step('Ctrl+C sends the interrupt byte and keeps the phone draft', async () => {
      await resetInputs()
      await page.fill('#compose', '保留草稿')
      if (await page.evaluate(() => document.querySelector('#special-keys').hidden)) await page.click('#toggle-keys', { label: 'expand shortcut key row' })
      await page.click('#special-keys [data-key="interrupt"]', { label: 'interrupt terminal command' })
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('\x03'))
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '保留草稿')
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['\x03'])
    })
    const moreKey = async key => {
      await page.click('#more-keys', { label: 'open terminal shortcut menu' })
      await page.waitForFunction(() => !document.querySelector('#keys-dialog').getAnimations().some(animation => animation.playState === 'running'))
      await page.click(`#keys-dialog [data-key="${key}"]`, { label: 'use terminal editing shortcut' })
    }
    await step('clear terminal input sends line-end and delete while keeping the phone draft', async () => {
      await resetInputs()
      await page.evaluate(() => window.__mobileFixture.pushScreen('mobile-1', '\x1b[2J\x1b[H$ typed-input', 80, 24))
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('$ typed-input'))
      await page.fill('#compose', '保留手机草稿')
      await moreKey('clear-input')
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('\x05\x15'))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['\x05\x15'])
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '保留手机草稿')
      await resetInputs()
      await moreKey('clear')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '')
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), [])
    })
    await step('clear terminal input works in raw mode and releases active modifiers', async () => {
      await page.click('#keyboard', { label: 'enable terminal live input' })
      await moreKey('alt')
      assert.equal(await page.evaluate(() => document.querySelector('#keys-dialog [data-key="clear-input"]').disabled), false)
      assert.equal(await page.evaluate(() => document.querySelector('#keys-dialog [data-key="clear"]').disabled), true)
      await page.click('#keys-dialog [data-key="clear-input"]', { label: 'clear terminal live input' })
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('\x05\x15'))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['\x05\x15'])
      assert.equal(await page.evaluate(() => document.querySelector('#keys-dialog [data-key="alt"]').getAttribute('aria-pressed')), 'false')
      await metrics(390, 844)
      await page.screenshot({ path: resolve(output, 'clear-input.png') })
    })
    await step('Windows PowerShell input uses Ctrl+Home and Ctrl+End instead of unbound Ctrl+U', async () => {
      await page.cdp('Emulation.clearDeviceMetricsOverride')
      await resetInputs()
      await page.evaluate(() => window.__mobileFixture.pushScreen('mobile-1', '\x1b[2J\x1b[HPS D:\\Code\\QingCode> pending text\x1b[5D', 80, 24))
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('pending text'))
      await moreKey('clear-input')
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.includes('\x1b[1;5H\x1b[1;5F'))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), ['\x1b[1;5H\x1b[1;5F'])
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    throw error
  }
}
