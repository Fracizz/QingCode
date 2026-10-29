import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, artifactDir, screenshots = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `direct-agent-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode Agent direct connection acceptance')
  const page = task.page('p1')
  const results = []
  const calls = () => page.evaluate(() => JSON.parse(document.querySelector('[data-testid="calls"]').textContent))
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  try {
    await page.goto('http://127.0.0.1:38439/web-tests/direct-agent.html')
    await page.click('loc=role:button[name="Agent 端口直连"]', { label: 'inspect independent Agent connection settings' })
    await page.waitForSelector('loc=role:button[name="测试直连"]')
    await step('service preparation shows a spinner and prevents duplicate requests', async () => {
      await page.click('loc=role:button[name="通过 SSH 安装或读取服务"]', { label: 'prepare Agent service' })
      const pending = await page.evaluate(() => {
        const button = document.querySelector('button[aria-busy="true"]')
        return { text: button?.textContent, disabled: button?.disabled, animation: button ? getComputedStyle(button.querySelector('svg')).animationName : null }
      })
      assert.equal(pending.text, '正在准备服务…')
      assert.equal(pending.disabled, true)
      assert.equal(pending.animation, 'spin')
      if (screenshots) await page.screenshot({ path: resolve(output, 'provisioning.png') })
      await page.click('loc=role:button[name="完成模拟服务准备"]', { label: 'complete simulated preparation' })
      await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'))
    })
    await step('fixed editable port and firewall instructions', async () => {
      assert.equal(await page.evaluate(() => document.querySelector('input[inputmode="numeric"]').value), '48763')
      assert.match(await page.evaluate(() => document.body.textContent), /远端需要开放 TCP 48763/)
      assert.match(await page.evaluate(() => document.body.textContent), /历史端口：49521、51234/)
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '保存并启用直连').disabled), true)
    })
    await step('SSH authorization shows source and Public network scope; cancel leaves firewall unchanged', async () => {
      await page.click('loc=role:button[name="通过 SSH 授权放行"]', { label: 'inspect SSH firewall authorization' })
      await page.waitForSelector('[role="alertdialog"]')
      assert.match(await page.evaluate(() => document.querySelector('[role="alertdialog"]').textContent), /公用网络/)
      assert.match(await page.evaluate(() => document.querySelector('[role="alertdialog"]').textContent), /允许来源：192.168.252.10/)
      assert.match(await page.evaluate(() => document.querySelector('[role="alertdialog"]').textContent), /接收地址：192.168.252.107/)
      assert.match(await page.evaluate(() => document.querySelector('[role="alertdialog"]').textContent), /网络范围：Public/)
      assert.equal((await calls()).some(value => value.startsWith('firewall-apply:')), false)
      await page.click('loc=role:button[name="取消"]', { label: 'cancel firewall authorization' })
      assert.equal((await calls()).some(value => value.startsWith('firewall-apply:')), false)
    })
    await step('explicit SSH authorization allows only current port and keeps Agent identity untrusted', async () => {
      await page.click('loc=role:button[name="通过 SSH 授权放行"]', { label: 'authorize current firewall scope' })
      await page.click('loc=role:button[name="授权放行"]', { label: 'approve displayed firewall rule' })
      await page.waitForFunction(() => document.querySelector('[data-testid="calls"]').textContent.includes('firewall-apply:48763'))
      await page.waitForFunction(() => document.body.textContent.includes('Agent 端口可达'))
      assert.equal((await calls()).some(value => value.startsWith('authenticate:')), false)
      assert.equal((await calls()).some(value => value.startsWith('save:')), false)
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '保存并启用直连').disabled), true)
      assert.match(await page.evaluate(() => document.body.textContent), /历史端口：49521、51234/)
    })
    await step('canceling identity confirmation does not send credentials', async () => {
      await page.click('loc=role:button[name="测试直连"]', { label: 'probe server certificate' })
      await page.waitForSelector('[role="alertdialog"]')
      assert.equal((await calls()).some(value => value.startsWith('authenticate:')), false)
      await page.click('loc=role:button[name="取消"]', { label: 'decline server trust' })
      assert.equal((await calls()).some(value => value.startsWith('authenticate:')), false)
    })
    await step('confirmed identity and successful authentication permit enabling direct connection', async () => {
      await page.click('loc=role:button[name="测试直连"]', { label: 'verify direct connection' })
      await page.click('loc=role:button[name="信任此服务器"]', { label: 'confirm fixture certificate' })
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '保存并启用直连' && !button.disabled))
      await page.click('loc=role:button[name="保存并启用直连"]', { label: 'save verified direct connection' })
      await page.waitForFunction(() => document.querySelector('[data-testid="calls"]').textContent.includes('save:true:48763'))
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'dark.png') })
    await step('editing the port invalidates previous verification', async () => {
      await page.fill('loc=role:textbox[name="TCP 端口"]', '51235', { label: 'edit direct connection port' })
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '保存并启用直连').disabled), true)
      assert.match(await page.evaluate(() => document.body.textContent), /远端需要开放 TCP 51235/)
    })
    await step('narrow light layout and English labels', async () => {
      await page.click('loc=role:button[name="切换主题"]', { label: 'inspect light theme' })
      await page.click('loc=role:button[name="切换语言"]', { label: 'inspect English translations' })
      await page.waitForSelector('loc=role:button[name="Test direct connection"]')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 800, deviceScaleFactor: 1, mobile: false })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      if (screenshots) await page.screenshot({ path: resolve(output, 'light-narrow-en.png') })
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, nativeConnection: false }, null, 2))
    await task.finish({ keep: [] })
    console.log({ output, results })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId, nativeConnection: false }, null, 2))
    console.log({ output, spaceId: task.spaceId })
    throw error
  }
}
