import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Real UI with memory data only. Reuse one TaskSpace across this and project-manager acceptance. */
export async function run({ spaceId, artifactDir, captureScreenshots = true } = {}) {
  const task = await taskSpace(spaceId ?? 'QingCode UI clarity Web tests')
  const page = task.page('p1')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `ui-clarity-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const results = []
  const screenshots = []
  const step = async (name, action) => {
    await action()
    results.push({ name, status: 'passed' })
    console.log(`PASS ${name}`)
  }
  const viewport = (width, height = 900) =>
    page.cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  const shot = async name => {
    if (!captureScreenshots) return
    const path = await page.screenshot({ path: resolve(output, `${name}.png`) })
    screenshots.push({ name, path })
  }
  const closeImport = () => page.press('input[aria-label="搜索连接"]', 'Escape')
  const scenario = (value, text) =>
    page
      .selectOption('select[aria-label="测试连接状态"]', value)
      .then(() =>
        page.waitForFunction(
          expected =>
            document.querySelector('[data-testid="ssh-status"] button')?.textContent === expected,
          text
        )
      )
  console.log({ spaceId: task.spaceId, output })
  try {
    await viewport(1440)
    await page.goto('http://127.0.0.1:38439/web-tests/ui-clarity.html')
    console.log(await page.snapshot())
    await step('来源和 SSH 状态使用可读辅助字号', async () => {
      await page.waitForSelector('[data-testid="ssh-status"] button', { state: 'visible' })
      assert.deepEqual(
        await page.evaluate(() =>
          ['[data-project-source]', '[data-testid="ssh-status"] button'].map(
            selector => getComputedStyle(document.querySelector(selector)).fontSize
          )
        ),
        ['12px', '12px']
      )
    })
    await step('认证、安装、服务连接、兼容和断开分别显示', async () => {
      await scenario('authenticating', 'SSH 正在认证')
      await scenario('installing', '正在安装远端服务')
      await scenario('handshaking', '正在连接远端服务')
      await scenario('compatibility', 'SSH 直连（兼容模式）')
      await scenario('disconnected', 'SSH 已断开')
      await scenario('readyServer', 'SSH + 远端服务')
    })
    await step('连接详情及服务日志可操作', async () => {
      await page.click('[data-testid="ssh-status"] button', {
        label: 'inspect remote service details',
      })
      console.log(await page.snapshot())
      await page.waitForSelector('loc=role:dialog[name="远程连接"]', { state: 'visible' })
      await page.click('loc=role:tab[name="服务日志"]', { label: 'inspect service log content' })
      await page.waitForFunction(() =>
        document.querySelector('pre')?.textContent.includes('文件监听已启动')
      )
      await page.press('loc=role:tab[name="服务日志"]', 'Escape')
    })
    await step('密钥详情支持键盘展开且不勾选连接', async () => {
      await page.click('loc=role:button[name="导入已有连接"]', { label: 'open connection import' })
      await page.waitForSelector('input[aria-label="Development"]', { state: 'visible' })
      console.log(await page.snapshot())
      const summary = '[aria-busy] > div:first-child summary'
      assert.equal(await page.evaluate(() => document.querySelector('details').open), false)
      await page.focus(summary)
      await page.press(summary, 'Enter')
      assert.deepEqual(
        await page.evaluate(() => ({
          open: document.querySelector('details').open,
          selected: document.querySelector('input[aria-label="Development"]').checked,
        })),
        { open: true, selected: false }
      )
      await shot('dark-import-details')
      await closeImport()
    })
    await step('三种主题复用真实表单与导入列表', async () => {
      for (const theme of ['dark', 'light', 'olive']) {
        await page.selectOption('select[aria-label="测试主题"]', theme)
        await shot(`${theme}-settings`)
        await page.click('loc=role:button[name="导入已有连接"]', {
          label: 'inspect themed import list',
        })
        await shot(`${theme}-import`)
        await closeImport()
      }
    })
    await step('窄窗口和较大字号不挤出操作按钮', async () => {
      await viewport(800, 900)
      await page.selectOption('select[aria-label="测试字号"]', '20')
      await shot('narrow-large-settings')
      await page.click('loc=role:button[name="导入已有连接"]', {
        label: 'inspect large font dialog',
      })
      assert.equal(
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]')
          const bounds = dialog.getBoundingClientRect()
          return (
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            dialog.scrollWidth <= dialog.clientWidth &&
            [...dialog.querySelectorAll('button')].every(button => {
              const rect = button.getBoundingClientRect()
              return rect.left >= bounds.left && rect.right <= bounds.right
            })
          )
        }),
        true
      )
      await shot('narrow-large-import')
      await closeImport()
    })
    await step('展开与搜索不改变显式导入范围', async () => {
      await page.selectOption('select[aria-label="测试字号"]', '13')
      await page.click('loc=role:button[name="导入已有连接"]', { label: 'verify import selection' })
      await page.fill('input[aria-label="搜索连接"]', 'Staging')
      await page.click('input[aria-label="Staging"]', { label: 'select staging connection' })
      await page.click('loc=role:button[name="确认导入"]', { label: 'import selected connection' })
      await page.waitForSelector('[role="dialog"]', { state: 'hidden' })
      await page.click('loc=role:button[name="导入已有连接"]', { label: 'verify saved connection' })
      assert.deepEqual(
        await page.evaluate(() => ({
          staging: document.querySelector('input[aria-label="Staging"]').disabled,
          development: document.querySelector('input[aria-label="Development"]').disabled,
        })),
        { staging: true, development: false }
      )
      await closeImport()
    })
    await step('英文文案、窄窗口及主题切换', async () => {
      await page.selectOption('select[aria-label="测试语言"]', 'en')
      await page.waitForSelector('loc=role:button[name="Import existing connections"]', {
        state: 'visible',
      })
      await page.click('loc=role:button[name="Import existing connections"]', {
        label: 'inspect English import dialog',
      })
      await page.waitForFunction(
        () => document.querySelector('summary')?.textContent === 'Authentication details'
      )
      await shot('english-narrow-import')
      await page.press('input[aria-label="Search connections"]', 'Escape')
    })
  } catch (error) {
    results.push({ name: 'acceptance', status: 'failed', error: String(error) })
    console.log(await page.snapshot())
    await writeFile(
      resolve(output, 'results.json'),
      JSON.stringify({ results, screenshots }, null, 2)
    )
    throw error
  }
  const report = {
    status: 'passed',
    results,
    screenshots,
    screenshotStatus: captureScreenshots ? 'captured' : 'not-captured',
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  const escape = value =>
    String(value).replace(
      /[&<>"']/g,
      character =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    )
  await writeFile(
    resolve(output, 'report.html'),
    `<!doctype html><meta charset="utf-8"><title>界面清晰度验收</title><style>body{font:16px system-ui;max-width:1100px;margin:36px auto;padding:20px}li{padding:8px}img{max-width:100%}</style><h1>界面清晰度 Web 验收</h1><p>真实组件、固定内存数据，不代表真实 SSH、文件或原生 Windows 缩放验收。</p><p>截图：${captureScreenshots ? '已保存' : '未完成，截图接口超时后使用 DOM 验收'}</p><ul>${results.map(result => `<li>${escape(result.status)} ${escape(result.name)}</li>`).join('')}</ul>${screenshots.map(shot => `<img src="${escape(shot.name)}.png">`).join('')}`
  )
  console.log({ passed: results.length, output, spaceId: task.spaceId })
  return { spaceId: task.spaceId, results, screenshots }
}
