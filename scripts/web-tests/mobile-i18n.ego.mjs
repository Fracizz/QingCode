// 安卓端国际化 Web 验收：英文模式下工作台、配对、终端与设置弹层不残留中文界面文案，
// 语言选择保存后重新加载生效，切回中文恢复原文。使用内存桥，不替代 Android 真机系统语言验收。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-i18n')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile i18n 20261105')
  const page = task.page('p1')
  const results = []
  // Ego 窗口未渲染时截图可能超时：只记录，不影响断言。
  const shots = []
  const shot = async name => {
    try { await page.screenshot({ path: resolve(output, name) }); shots.push(name) } catch (error) { shots.push(name + ' (skipped: ' + error.name + ')') }
  }
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  // 收集可见界面中的中文（排除测试夹具里的用户数据：连接名、项目名、终端输出）。
  const leftovers = () => page.evaluate(() => {
    const han = /[一-鿿]/
    const skip = el => el.closest('#viewport, #history-content, #reader-content, .xterm, #terminal-profiles, #pair-name, #host-name')
    const found = new Set()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!el || skip(el) || el.closest('option[value="zh"]') || !han.test(node.nodeValue)) continue
      if (el.closest('[hidden]') || (el.closest('dialog') && !el.closest('dialog').open)) continue
      found.add(node.nodeValue.trim())
    }
    for (const el of document.querySelectorAll('[placeholder], [aria-label]')) {
      for (const name of ['placeholder', 'aria-label']) {
        const value = el.getAttribute(name)
        if (value && han.test(value) && !skip(el)) found.add(name + ': ' + value)
      }
    }
    return [...found]
  })
  // 夹具数据中的中文名称和语言选项的「中文」允许出现。
  const allowed = text => text === '中文' || /工作电脑|部署/.test(text)
  const assertEnglish = async where => {
    const rest = (await leftovers()).filter(text => !allowed(text))
    assert.deepEqual(rest, [], where)
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.goto(baseUrl + '/mobile-android/?lang=en')
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await step('home renders in English before pairing', async () => {
      await page.waitForFunction(() => document.querySelector('#home-empty-title').textContent === 'Connect to QingCode')
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
      await assertEnglish('home')
    })
    await shot('home-en.png')
    await step('settings page shows the language selector', async () => {
      await page.click('#open-settings', { label: 'open settings' })
      await page.waitForSelector('#settings-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#app-language [aria-checked="true"]').dataset.locale), 'en')
      await assertEnglish('settings')
      await shot('settings-en.png')
      await page.click('#settings-dialog [data-close]', { label: 'close settings' })
      await page.click('#dashboard-nav [data-page="connection"]', { label: 'open connections page' })
      await assertEnglish('connections')
    })
    await shot('connections-en.png')
    await step('pairing dialog and errors are English', async () => {
      await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, '工作电脑')))
      await page.waitForSelector('#pair-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#pair-submit').textContent), 'Connect')
      await page.fill('#pair-code', 'wrong-1')
      await page.click('#pair-submit', { label: 'submit wrong password' })
      await page.waitForFunction(() => !document.querySelector('#pair-error').hidden)
      // 电脑端返回的中文错误在显示时翻译。
      assert.doesNotMatch(await page.evaluate(() => document.querySelector('#pair-error').textContent), /[一-鿿]/)
      await assertEnglish('pair dialog')
      await shot('pair-en.png')
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit', { label: 'pair test computer' })
      await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    })
    await step('projects and terminal are English', async () => {
      await page.click('#dashboard-nav [data-page="project"]', { label: 'browse trusted projects' })
      await page.waitForFunction(() => /projects$/.test(document.querySelector('#list-label').textContent))
      await assertEnglish('projects')
      await shot('projects-en.png')
      await page.click('#project-list .row:first-child', { label: 'open terminal project' })
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === 'In session')
      await page.evaluate(() => { document.querySelector('#input-tip').hidden = false })
      await assertEnglish('terminal')
      await shot('terminal-en.png')
    })
    await step('terminal dialogs are English', async () => {
      for (const id of ['session-dialog', 'settings-dialog', 'keys-dialog', 'terminal-menu-dialog', 'key-layout-dialog']) {
        await page.evaluate(dialog => document.getElementById(dialog).showModal(), id)
        await assertEnglish(id)
        await shot(id + '-en.png')
        await page.evaluate(dialog => document.getElementById(dialog).close(), id)
      }
      await page.click('#show-sessions', { label: 'open session drawer' })
      await page.waitForSelector('#session-drawer[open]')
      await assertEnglish('session drawer')
      assert.match(await page.evaluate(() => document.querySelector('#session-options').textContent), /Terminal 1/)
      await shot('drawer-en.png')
    })
    await step('switching back to Chinese reloads with original text', async () => {
      await page.evaluate(() => { localStorage.setItem('qingcode:mobile:locale', 'en'); location.href = location.pathname })
      await page.waitForFunction(() => document.readyState === 'complete' && !!document.querySelector('#app-language'))
      await page.click('#open-settings', { label: 'open settings' })
      await page.waitForSelector('#settings-dialog[open]')
      await page.click('#app-language [data-locale="zh"]', { label: 'choose Chinese' })
      await page.waitForFunction(() => document.documentElement.lang === 'zh-CN' && document.querySelector('#dashboard-nav [data-page="connection"]').textContent.trim() === '连接')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:locale')), 'zh')
    })
    await shot('home-zh.png')
  } catch (error) {
    results.push({ name: 'failure', passed: false, error: String(error?.stack ?? error) })
    await shot('failure.png')
    throw error
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, shots }, null, 2))
    console.log(JSON.stringify({ spaceId: task.spaceId, results, shots }, null, 2))
  }
}
