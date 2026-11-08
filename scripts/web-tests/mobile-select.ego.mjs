// 安卓下拉选项 Web 验收：不露出系统控件、窄屏与横屏的选择面板、选中保存、取消路径、显示同步。
// 使用真实 Web 资产和内存桥，不替代 Android 真机验收。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-select')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile select 20261106')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const shots = []
  const shot = async name => {
    try { await page.screenshot({ path: resolve(output, name) }); shots.push(name) } catch (error) { shots.push(name + ' (skipped: ' + error.name + ')') }
  }
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const metrics = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
  const settled = id => page.waitForFunction(value => !document.getElementById(value).getAnimations().some(animation => animation.playState === 'running'), id)
  const isOpen = id => page.evaluate(value => document.getElementById(value).open, id)
  const triggerText = id => page.evaluate(value => document.getElementById(value).parentElement.querySelector('.select-value').textContent, id)
  const openMenu = async id => {
    await page.evaluate(value => document.getElementById(value).parentElement.querySelector('.select-trigger').click(), id)
    await page.waitForSelector('#select-dialog[open]')
    await settled('select-dialog')
  }
  const openSettings = async () => {
    await page.click('#open-settings', { label: 'open settings' })
    await page.waitForSelector('#settings-dialog[open]')
    await settled('settings-dialog')
  }
  try {
    await metrics(390, 844)
    await page.goto(baseUrl + '/mobile-android/?lang=zh')
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await metrics(390, 844)
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await openSettings()

    await step('4 个下拉由项目样式的按钮呈现、5 个开关项渲染为开关，系统控件不可触达', async () => {
      assert.ok(await page.evaluate(() => {
        const selects = [...document.querySelectorAll('select')]
        return selects.length === 9 && selects.filter(select => select.dataset.control === 'switch').length === 5 && selects.every(select => {
          const trigger = select.parentElement.querySelector(select.dataset.control === 'switch' ? '.switch' : '.select-trigger')
          const style = getComputedStyle(select)
          return trigger && style.opacity === '0' && style.pointerEvents === 'none' && select.tabIndex === -1
        })
      }))
      assert.equal(await triggerText('image-compression'), '中压缩')
      await page.evaluate(() => document.querySelector('#send-mode').scrollIntoView({ block: 'center' }))
      await settled('settings-dialog')
      await shot('settings-triggers-390.png')
    })

    await step('窄屏点开是贴底面板，文案拆两行并标出当前项', async () => {
      await openMenu('image-compression')
      const layout = await page.evaluate(() => {
        const bounds = document.querySelector('#select-dialog').getBoundingClientRect()
        const rows = [...document.querySelectorAll('#select-options .select-option')]
        const checked = rows.filter(row => row.getAttribute('aria-checked') === 'true')
        return {
          bottomGap: innerHeight - bounds.bottom,
          fullWidth: Math.abs(bounds.width - innerWidth) <= 1,
          title: document.querySelector('#select-dialog-title').textContent,
          count: rows.length,
          minHeight: Math.min(...rows.map(row => row.getBoundingClientRect().height)),
          checked: checked.map(row => row.querySelector('strong').textContent),
          detail: checked[0]?.querySelector('small').textContent,
          checkVisible: getComputedStyle(checked[0].querySelector('svg')).visibility,
          expanded: document.querySelector('#image-compression').parentElement.querySelector('.select-trigger').getAttribute('aria-expanded'),
        }
      })
      assert.ok(Math.abs(layout.bottomGap) <= 1 && layout.fullWidth, JSON.stringify(layout))
      assert.equal(layout.title, '图片压缩')
      assert.equal(layout.count, 4)
      assert.ok(layout.minHeight >= 44)
      assert.deepEqual(layout.checked, ['中压缩'])
      assert.equal(layout.detail, '推荐')
      assert.equal(layout.checkVisible, 'visible')
      assert.equal(layout.expanded, 'true')
      await shot('select-sheet-390.png')
    })

    await step('选中后立即生效、保存并关闭，设置页仍保持打开', async () => {
      await page.evaluate(() => [...document.querySelectorAll('#select-options .select-option')].find(row => row.textContent.includes('高压缩')).click())
      assert.equal(await isOpen('select-dialog'), false)
      assert.equal(await isOpen('settings-dialog'), true)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:image-compression')), 'high')
      assert.equal(await triggerText('image-compression'), '高压缩')
    })

    await step('返回键和遮罩只取消，不改变当前值', async () => {
      await openMenu('send-mode')
      await page.evaluate(() => window.qingBack())
      assert.equal(await isOpen('select-dialog'), false)
      assert.equal(await isOpen('settings-dialog'), true)
      await openMenu('send-mode')
      await page.evaluate(() => {
        const dialog = document.querySelector('#select-dialog')
        for (const type of ['pointerdown', 'pointerup']) dialog.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 5, clientY: 5 }))
      })
      assert.equal(await isOpen('select-dialog'), false)
      assert.equal(await page.evaluate(() => document.querySelector('#send-mode').value), 'default')
    })

    await step('设置行整行可点：点标签打开选择面板', async () => {
      await page.evaluate(() => document.querySelector('label[for="send-mode"]').click())
      assert.equal(await isOpen('select-dialog'), true)
      await page.evaluate(() => window.qingBack())
      assert.equal(await isOpen('select-dialog'), false)
      assert.equal(await isOpen('select-dialog'), false)
    })

    await step('程序赋值和语言切换都会同步按钮文字', async () => {
      await page.evaluate(() => { document.querySelector('#terminal-renderer').value = 'off' })
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-renderer ~ .switch').getAttribute('aria-checked')), 'false')
      await page.evaluate(() => { document.querySelector('#terminal-renderer').value = 'on' })
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-renderer ~ .switch').getAttribute('aria-checked')), 'true')
      await page.evaluate(() => document.querySelector('#app-language [data-locale="en"]').click())
      await page.waitForFunction(() => document.querySelector('#image-compression').parentElement.querySelector('.select-value').textContent !== '高压缩')
      const english = await triggerText('image-compression')
      assert.ok(/^[\x20-\x7e·]+$/.test(english), english)
      await openMenu('image-compression')
      assert.ok(await page.evaluate(() => /^[\x20-\x7e·]+$/.test(document.querySelector('#select-options').textContent) && /^[\x20-\x7e]+$/.test(document.querySelector('#select-dialog-title').textContent)))
      await page.evaluate(() => window.qingBack())
      await page.evaluate(() => document.querySelector('#app-language [data-locale="zh"]').click())
      await page.waitForFunction(() => document.querySelector('#image-compression').parentElement.querySelector('.select-value').textContent === '高压缩')
    })

    await step('横屏面板居中且不溢出', async () => {
      await metrics(844, 390)
      await settled('settings-dialog')
      await openMenu('send-mode')
      const fits = await page.evaluate(() => {
        const bounds = document.querySelector('#select-dialog').getBoundingClientRect()
        return bounds.top >= 0 && bounds.bottom <= innerHeight && Math.abs(bounds.left - (innerWidth - bounds.right)) <= 1
      })
      assert.ok(fits)
      await shot('select-landscape.png')
      await page.evaluate(() => window.qingBack())
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
