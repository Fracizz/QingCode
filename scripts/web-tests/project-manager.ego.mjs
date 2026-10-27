import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const selectors = {
  dialog: '[role="dialog"][aria-labelledby="project-manager-title"]',
  search: 'input[aria-label="搜索项目名称、路径或来源"]',
  source: 'select[aria-label="筛选项目来源"]',
  pageSize: '[role="dialog"] label select',
  sort: 'select[aria-label="项目排序"]',
}

/** Run inside `ego-browser nodejs`, after reading `ego-browser skill`. No Playwright dependency. */
export async function run({ spaceId, url = 'http://127.0.0.1:38439/', artifactDir, captureScreenshots = true } = {}) {
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `project-manager-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode project manager Web tests')
  const page = task.page('p1')
  const tabInfo = (await task.tabs()).find(tab => tab.label === page.label)
  const browserWindow = await task.cdp('Browser.getWindowForTarget', { targetId: tabInfo.targetId })
  if (browserWindow.bounds.windowState === 'minimized') {
    await task.cdp('Browser.setWindowBounds', {
      windowId: browserWindow.windowId,
      bounds: { windowState: 'normal' },
    })
  }
  console.log({ spaceId: task.spaceId, url, output })
  const results = []
  const screenshots = []
  let failure
  const step = async (name, action) => {
    try {
      await action()
      results.push({ name, status: 'passed' })
      await writeFile(resolve(output, 'progress.json'), JSON.stringify(results, null, 2))
      console.log(`PASS ${name}`)
    } catch (error) {
      results.push({ name, status: 'failed', error: String(error) })
      throw error
    }
  }
  const click = name =>
    page.click(`loc=role:${name === '全选当前页' ? 'checkbox' : 'button'}[name="${name}"]`, {
      label: 'verify project manager action',
    })
  const tab = name =>
    page.click(`loc=role:tab[name="${name}"]`, { label: 'filter project visibility' })
  const source = value => page.selectOption(selectors.source, { value })
  const search = value => page.fill(selectors.search, value)
  const expectRange = async (total, start = total ? 1 : 0, end = Math.min(total, 10)) => {
    const expected = `显示 ${start}-${end} 项，共 ${total} 项`
    await page.waitForFunction(
      text => document.querySelector('[role="status"]')?.textContent === text,
      expected,
      { timeout: 5000 }
    )
  }
  const names = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')].map(row =>
        row.querySelector('td:nth-child(2) button')?.getAttribute('aria-label')
      )
    )
  const expectNames = async expected => assert.deepEqual(await names(), expected)
  const expectSelected = count =>
    page.waitForFunction(
      count => {
        const text = document.querySelector('[role="dialog"]')?.textContent ?? ''
        return count === 0 ? !/已选 \d+ 项/.test(text) : text.includes(`已选 ${count} 项`)
      },
      count,
      { timeout: 5000 }
    )
  const saveIds = () =>
    page.evaluate(
      () =>
        JSON.parse(document.querySelector('[data-testid="operation-log"]').textContent)
          .filter(op => op.action === 'saveWorkspace')
          .at(-1)?.ids
    )
  const clearConditions = async () => {
    await search('')
    await source('all')
    await tab('全部')
  }
  const shot = async name => {
    if (!captureScreenshots) return
    const path = await page.screenshot({
      path: resolve(output, `${name}.png`).replaceAll('\\', '/'),
    })
    screenshots.push({ name, path })
  }
  const checkToolbar = () =>
    page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const selectors = [
        'input[aria-label="搜索项目名称、路径或来源"]',
        'select[aria-label="筛选项目来源"]',
        '[role="tablist"]',
        'select[aria-label="项目排序"]',
      ]
      const rects = selectors.map(selector => {
        const rect = dialog.querySelector(selector).getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
        }
      })
      return {
        withinViewport: rects.every(
          rect => rect.left >= 0 && rect.right <= innerWidth && rect.width > 0
        ),
        overlapping: rects.some((rect, index) =>
          rects
            .slice(index + 1)
            .some(
              other =>
                Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 &&
                Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1
            )
        ),
      }
    })
  try {
    // Collect JS failures without accessing the user's desktop or requiring DevTools UI.
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__webTestErrors=[]; addEventListener('error',e=>window.__webTestErrors.push(e.message)); addEventListener('unhandledrejection',e=>window.__webTestErrors.push(String(e.reason)));`,
    })
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await page.cdp('Page.bringToFront')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForSelector(selectors.dialog, { state: 'visible', timeout: 15000 })
    await step('固定数据、临时项目排除及同名来源标签', async () => {
      await expectRange(16)
      const text = await page.evaluate(() => document.querySelector('[role="dialog"]').textContent)
      assert.ok(text.includes('共 16 个 · 显示 5 · 隐藏 11'))
      assert.ok(!text.includes('temporary-scratch'))
      assert.ok((await names()).includes('django [WSL · Ubuntu]'))
      assert.ok((await names()).includes('django [WSL · root@localhost]'))
      await shot('desktop')
    })
    await step('原生 WSL、Ubuntu、Debian 与 SSH 连接分别筛选', async () => {
      for (const [value, total] of [
        ['wsl', 3],
        ['wsl:Ubuntu', 2],
        ['wsl:Debian', 1],
        ['ssh', 6],
        ['ssh:fixture-wsl', 3],
        ['ssh:fixture-windev', 3],
        ['local', 7],
      ]) {
        await source(value)
        await expectRange(total)
      }
      await source('wsl:Debian')
      await expectNames(['debian-service'])
    })
    await step('名称、路径、连接、主机、账号与大小写搜索', async () => {
      await source('all')
      for (const [query, total] of [
        ['  DJANGO  ', 3],
        ['Ubuntu', 2],
        ['WINDEV', 3],
        ['192.0.2.107:28822', 3],
        ['administrator', 3],
        ['root@localhost', 3],
        ['/home/code/django', 2],
        ['D:/fixtures', 7],
        ['WSL', 6],
      ]) {
        await search(query)
        await expectRange(total)
      }
    })
    await step('关键词、来源、显示状态组合与空结果', async () => {
      await search('django')
      await source('ssh:fixture-wsl')
      await tab('已隐藏')
      await expectRange(1)
      await expectNames(['django [WSL · root@localhost]'])
      await tab('已显示')
      await expectRange(0)
      const navigation = await page.evaluate(() =>
        ['上一页', '下一页'].map(
          name => document.querySelector(`button[aria-label="${name}"]`).disabled
        )
      )
      assert.deepEqual(navigation, [true, true])
      await clearConditions()
      await source('wsl')
      await tab('已显示')
      await expectRange(1)
      await tab('已隐藏')
      await expectRange(2)
    })
    await step('全量分页、来源变化复位及每页数量', async () => {
      await clearConditions()
      await click('下一页')
      await expectRange(16, 11, 16)
      await source('local')
      await expectRange(7)
      await source('all')
      await click('下一页')
      await page.selectOption(selectors.pageSize, '20')
      await expectRange(16, 1, 16)
      await page.selectOption(selectors.pageSize, '10')
      await expectRange(16)
    })
    await step('排序应用于全部筛选结果', async () => {
      await source('wsl')
      await click('名称')
      await expectNames(['debian-service', 'django [WSL · Ubuntu]', 'ubuntu-tools'])
      await click('切换排序方向')
      await expectNames(['ubuntu-tools', 'django [WSL · Ubuntu]', 'debian-service'])
      await source('all')
      await page.selectOption(selectors.sort, 'last_opened_at')
    })
    await step('跨页全选、筛选清理选择及批量保存参数', async () => {
      await click('全选当前页')
      await expectSelected(10)
      await click('下一页')
      await click('全选当前页')
      await expectSelected(16)
      await tab('已显示')
      await expectSelected(5)
      await click('保存选中为多项目工作区')
      assert.deepEqual(
        new Set(await saveIds()),
        new Set(['ubuntu-django', 'win-nem', 'win-django', 'win-qingcode', 'wsl-nem'])
      )
      await source('wsl')
      await expectSelected(1)
      await click('保存选中为多项目工作区')
      assert.deepEqual(await saveIds(), ['ubuntu-django'])
      await clearConditions()
      await click('取消选择')
    })
    await step('清除搜索恢复列表及键盘焦点', async () => {
      await search('no-such-fixture')
      await expectRange(0)
      await click('清除搜索')
      await expectRange(16)
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        '搜索项目名称、路径或来源'
      )
    })
    await step('行内隐藏与恢复只修改内存数据', async () => {
      await source('wsl:Ubuntu')
      await search('django')
      await click('从顶栏隐藏')
      await tab('已显示')
      await expectRange(0)
      await tab('已隐藏')
      await expectRange(1)
      await click('恢复显示')
      await expectRange(0)
      await clearConditions()
    })
    await step('800px 窄窗布局和筛选可操作性', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', {
        width: 800,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      })
      assert.deepEqual(await checkToolbar(), { withinViewport: true, overlapping: false })
      await source('wsl')
      await expectRange(3)
      await shot('narrow')
      await source('all')
    })
    await step('Escape 关闭、重新打开与数据重置', async () => {
      await page.press(selectors.search, 'Escape')
      await page.waitForSelector(selectors.dialog, { state: 'hidden' })
      await click('重置测试数据')
      await expectRange(16)
      await click('关闭')
      await click('打开项目管理')
      await expectRange(16)
    })
    await step('浅色主题复用生产样式', async () => {
      await click('关闭')
      await page.cdp('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await page.selectOption('select[aria-label="测试主题"]', 'light')
      await click('打开项目管理')
      await expectRange(16)
      await shot('light')
    })
    await step('英文界面翻译与来源选项', async () => {
      await click('关闭')
      await page.selectOption('select[aria-label="测试语言"]', 'en')
      await page.waitForFunction(
        () => document.querySelector('select[aria-label="测试语言"]')?.value === 'en'
      )
      await click('打开项目管理')
      await page.waitForSelector('input[aria-label="Search project names, paths, or sources"]', {
        state: 'visible',
      })
      await page.selectOption('select[aria-label="Filter project sources"]', 'wsl')
      await page.waitForFunction(
        () => document.querySelector('[role="status"]')?.textContent === 'Showing 1-3 of 3 projects'
      )
      await shot('english')
    })
    await step('浏览器无未捕获异常', async () => {
      assert.deepEqual(await page.evaluate(() => window.__webTestErrors ?? []), [])
    })
    console.log(await page.snapshot())
  } catch (error) {
    failure = error
    console.error(String(error))
    console.log(await page.snapshot())
    try {
      await shot('failure')
    } catch (screenshotError) {
      console.error(String(screenshotError))
    }
  }
  const report = {
    status: failure ? 'failed' : 'passed',
    url,
    spaceId: task.spaceId,
    results,
    screenshots,
    screenshotStatus: captureScreenshots ? 'captured' : 'not-captured',
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  const escape = text =>
    String(text).replace(
      /[&<>"']/g,
      character =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    )
  await writeFile(
    resolve(output, 'report.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>项目管理 Web 验收</title><style>body{font:16px system-ui;max-width:1100px;margin:36px auto;padding:0 20px;background:#18191d;color:#eee}li{padding:8px}img{max-width:100%;border:1px solid #555}a{color:#80c7ff}</style><h1>项目管理 Web + ego 验收：${escape(report.status)}</h1><p>真实 React 组件与样式，内存适配器。此报告不代表原生文件、SSH 或终端能力验收。</p><p>截图：${captureScreenshots ? '已保存' : '未完成，截图接口超时后使用 DOM 验收'}</p><ul>${results.map(result => `<li>${result.status === 'passed' ? '✓' : '✕'} ${escape(result.name)}${result.error ? `<pre>${escape(result.error)}</pre>` : ''}</li>`).join('')}</ul>${screenshots.map(screenshot => `<h2>${escape(screenshot.name)}</h2><a href="${escape(screenshot.name)}.png"><img src="${escape(screenshot.name)}.png"></a>`).join('')}</html>`
  )
  console.log(
    JSON.stringify(
      {
        status: report.status,
        passed: results.filter(result => result.status === 'passed').length,
        report: resolve(output, 'report.html'),
        screenshots,
      },
      null,
      2
    )
  )
  if (failure) throw failure
  await task.finish({ keep: [] })
  return report
}
