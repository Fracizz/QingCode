// 安卓端在线更新 Web 验收：检查更新、beta 手机收到 beta 版、下载进度、安装授权与系统确认、
// 取消下载、跳过此版本、首页提示卡片与检查失败。使用内存桥，不替代真机下载与系统安装器验收。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const apk = version => `https://github.com/Fracizz/QingCode/releases/download/v${version}/QingCode_${version}-android.apk`

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-update')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile online update 20261105')
  const page = task.page('p1')
  const results = []
  const shots = []
  const shot = async name => {
    try { await page.screenshot({ path: resolve(output, name) }); shots.push(name) } catch (error) { shots.push(name + ' (skipped: ' + error.name + ')') }
  }
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const text = selector => page.evaluate(value => document.querySelector(value).textContent.trim(), selector)
  const waitText = (selector, pattern) => page.waitForFunction(([value, source]) => new RegExp(source).test(document.querySelector(value).textContent), [selector, pattern.source])
  const releases = list => page.evaluate(value => { window.__mobileFixture.state.update.list.releases = value }, list)
  const fresh = async () => {
    await page.goto(baseUrl + '/mobile-android/?lang=zh')
    // 等首次后台检查写完偏好再清空，避免迟到的写入覆盖清理结果。
    await page.waitForFunction(() => !!localStorage.getItem('qingcode:mobile:update') || window.__mobileFixture.state.update.checks > 0)
    await page.waitForFunction(() => !!localStorage.getItem('qingcode:mobile:update'))
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:') && key !== 'qingcode:mobile:locale') localStorage.removeItem(key)
    })
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => /0\.1\.15-beta\.3/.test(document.querySelector('#update-version').textContent))
  }
  const beta4 = {
    tag: 'v0.1.15-beta.4', prerelease: true, draft: false, page: 'https://github.com/Fracizz/QingCode/releases/tag/v0.1.15-beta.4',
    body: '### 中文\n- 手机版支持在线更新\n\n### English\n- Online update for Android',
    assets: [{ name: 'QingCode_0.1.15-beta.4-android.apk', url: apk('0.1.15-beta.4'), size: 3_145_728 }],
  }
  // 更新的版本但没有 APK：应被跳过。
  const beta5NoApk = { tag: 'v0.1.15-beta.5', prerelease: true, draft: false, body: '', assets: [] }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await fresh()
    await step('startup reads the installed version and checks in the background once', async () => {
      await page.waitForFunction(() => window.__mobileFixture.state.update.checks === 1)
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qingcode:mobile:update')).lastCheck > 0), true)
      assert.equal(await page.evaluate(() => document.querySelector('#update-card').hidden), true)
    })
    await step('manual check on a beta phone finds the newest beta that ships an APK', async () => {
      await page.click('#open-settings', { label: 'open settings' })
      await releases([beta5NoApk, beta4])
      await page.click('#update-check', { label: 'check for updates' })
      await page.waitForSelector('#update-dialog[open]')
      assert.match(await text('#update-dialog-version'), /0\.1\.15-beta\.4.*0\.1\.15-beta\.3.*3\.0 MB.*测试版/)
      assert.match(await text('#update-notes'), /在线更新/)
      assert.equal(await text('#update-action'), '下载并安装')
      assert.match(await text('#update-status'), /发现新版本 0\.1\.15-beta\.4/)
    })
    await shot('dialog.png')
    await step('download shows progress, then install asks for permission and opens the system confirmation', async () => {
      await page.click('#update-action', { label: 'download update' })
      await waitText('#update-dialog-status', /正在下载 \d+%/)
      assert.equal(await text('#update-action'), '取消下载')
      await shot('downloading.png')
      await waitText('#update-dialog-status', /安装包已通过校验/)
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.update.downloads), [{ url: apk('0.1.15-beta.4'), size: 3_145_728 }])
      assert.equal(await text('#update-action'), '安装')
      assert.equal(await page.evaluate(() => document.querySelector('#update-skip').hidden), true)
      await page.click('#update-action', { label: 'install update' })
      await waitText('#update-dialog-status', /允许 QingCode 安装应用/)
      await shot('permission.png')
      await page.click('#update-action', { label: 'install after granting' })
      await waitText('#update-dialog-status', /请在系统界面确认安装/)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.update.installs), 2)
    })
    await step('downloads can be canceled', async () => {
      await fresh()
      await releases([beta4])
      await page.evaluate(() => { window.__mobileFixture.state.update.stepDelay = 400 })
      await page.click('#open-settings', { label: 'open settings' })
      await page.click('#update-check', { label: 'check for updates' })
      await page.waitForSelector('#update-dialog[open]')
      await page.click('#update-action', { label: 'download update' })
      await page.waitForFunction(() => document.querySelector('#update-action').textContent === '取消下载')
      await page.click('#update-action', { label: 'cancel download' })
      await waitText('#update-dialog-status', /已取消下载/)
      assert.equal(await text('#update-action'), '下载并安装')
    })
    await step('home card offers the update until the version is skipped', async () => {
      await page.evaluate(() => { document.querySelector('#update-dialog').close(); document.querySelector('#settings-dialog').close() })
      await page.click('#dashboard-nav [data-page="home"]', { label: 'open home' })
      await page.waitForFunction(() => !document.querySelector('#update-card').hidden)
      assert.match(await text('#update-card-version'), /0\.1\.15-beta\.4/)
      await shot('home-card.png')
      await page.click('#update-card', { label: 'open update from home' })
      await page.waitForSelector('#update-dialog[open]')
      await page.click('#update-skip', { label: 'skip this version' })
      await page.waitForFunction(() => !document.querySelector('#update-dialog').open && document.querySelector('#update-card').hidden)
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qingcode:mobile:update')).skipped), '0.1.15-beta.4')
    })
    await step('stable phones ignore betas; no update reports latest', async () => {
      await page.goto(baseUrl + '/mobile-android/?lang=zh&appVersion=0.1.15&appCode=115999')
      await page.waitForFunction(() => /0\.1\.15$/.test(document.querySelector('#update-version').textContent))
      await page.click('#open-settings', { label: 'open settings' })
      await page.evaluate(() => {
        window.__mobileFixture.state.update.list.releases = [{ tag: 'v0.1.16-beta.1', prerelease: true, draft: false, body: '', assets: [{ name: 'QingCode_0.1.16-beta.1-android.apk', url: 'https://github.com/Fracizz/QingCode/releases/download/v0.1.16-beta.1/QingCode_0.1.16-beta.1-android.apk', size: 1 }] }]
      })
      await page.click('#update-check', { label: 'check for updates' })
      await waitText('#update-status', /已是最新版本/)
    })
    await step('check failures are shown in the current language and automatic checks can be disabled', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.update.checkError = '无法连接 GitHub 或 Gitee 检查更新，请检查网络后重试。' })
      await page.click('#update-check', { label: 'check for updates (offline)' })
      await waitText('#update-status', /无法连接 GitHub 或 Gitee/)
      await page.click('#update-auto', { label: 'disable automatic checks' })
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qingcode:mobile:update')).auto), false)
      await shot('connections.png')
    })
    await step('English UI translates the update flow', async () => {
      await page.goto(baseUrl + '/mobile-android/?lang=en')
      await page.waitForFunction(() => /Current version/.test(document.querySelector('#update-version').textContent))
      await page.click('#open-settings', { label: 'open settings' })
      assert.equal(await text('#update-check'), 'Check for updates')
      await releases([beta4])
      await page.click('#update-check', { label: 'check for updates in English' })
      await page.waitForSelector('#update-dialog[open]')
      assert.match(await text('#update-dialog-version'), /Version 0\.1\.15-beta\.4 \(current 0\.1\.15-beta\.3\).*Beta/)
      assert.equal(await text('#update-action'), 'Download and install')
      await shot('dialog-en.png')
      await page.goto(baseUrl + '/mobile-android/?lang=zh')
    })
  } catch (error) {
    results.push({ name: 'failure', passed: false, error: String(error?.stack ?? error) })
    await shot('failure.png')
    throw error
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, shots }, null, 2))
    console.log(JSON.stringify({ spaceId: task.spaceId, results, shots }, null, 2))
  }
}
