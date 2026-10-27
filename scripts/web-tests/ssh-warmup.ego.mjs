import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Run with ego-browser nodejs; the native queue/SSH boundaries have separate tests. */
export async function run({ spaceId, artifactDir, screenshots = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `ssh-warmup-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode remote background preparation 20261027')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => {
    try {
      await work()
      results.push({ name, status: 'passed' })
    } catch (error) {
      results.push({ name, status: 'failed', error: String(error) })
      throw error
    }
  }
  const shot = name =>
    screenshots ? page.screenshot({ path: resolve(output, `${name}.png`) }) : undefined
  try {
    await page.goto('http://127.0.0.1:38439/web-tests/ssh-warmup.html')
    await step('five production status icons without a blocking dialog', async () => {
      await page.waitForSelector('[data-phase="ready"] [role="img"]')
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('[data-phase] [role="img"]').length),
        5
      )
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length),
        0
      )
    })
    for (const phase of ['queued', 'preparing', 'ready', 'attention', 'failed']) {
      await step(`${phase} tooltip and activation remain accessible`, async () => {
        await page.hover(`[data-phase="${phase}"] [role="img"]`, {
          label: 'inspect remote preparation status',
        })
        await page.waitForSelector('[role="tooltip"]')
        const text = await page.evaluate(
          () => document.querySelector('[role="tooltip"]')?.textContent
        )
        assert.ok(text?.includes(phase === 'failed' ? '测试连接不可达' : '远程项目'))
        await page.click(`[data-phase="${phase}"]`, { label: 'open prepared remote project' })
        await page.waitForFunction(
          value => document.querySelector('[role="status"]')?.textContent === `已点击 ${value}`,
          phase
        )
      })
    }
    await shot('dark')
    await step('light theme', async () => {
      await page.click('loc=role:button[name="切换主题"]', { label: 'check light theme icons' })
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
      await shot('light')
    })
    await step('English status translations', async () => {
      await page.click('loc=role:button[name="切换语言"]', {
        label: 'check translated remote status',
      })
      await page.waitForFunction(() =>
        document
          .querySelector('[data-phase="ready"] [role="img"]')
          ?.getAttribute('aria-label')
          ?.startsWith('Remote project prepared')
      )
      await shot('english')
    })
    await step('narrow viewport has no horizontal overflow', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', {
        width: 400,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      })
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      )
      await shot('narrow')
      await page.cdp('Emulation.clearDeviceMetricsOverride')
    })
    await writeFile(
      resolve(output, 'results.json'),
      JSON.stringify(
        {
          results,
          nativeSsh: false,
          screenshots,
          ...(screenshots
            ? {}
            : {
                screenshotLimitation:
                  'Page.captureScreenshot timed out; DOM interaction acceptance only.',
              }),
        },
        null,
        2
      )
    )
    console.log({ output, results })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(
      resolve(output, 'results.json'),
      JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2)
    )
    console.log({ output, spaceId: task.spaceId })
    throw error
  }
}
