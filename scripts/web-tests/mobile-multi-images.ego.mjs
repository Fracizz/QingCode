import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-multi-images')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile collapse and multi image 20261104')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const metrics = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
  const settled = () => page.waitForFunction(() => !document.querySelector('#attach-image').disabled
    && window.__mobileFixture.state.imageSelections.size === 0)
  const geometry = () => page.evaluate(() => {
    const viewport = document.querySelector('#viewport')
    const grid = viewport.querySelector('.xterm-screen').getBoundingClientRect()
    const view = viewport.getBoundingClientRect()
    const tools = document.querySelector('#terminal-tools').getBoundingClientRect()
    const attach = document.querySelector('#attach-image').getBoundingClientRect()
    return { bottom: grid.bottom, right: grid.right, viewBottom: view.bottom, toolsTop: tools.top,
      attachVisible: attach.width >= 44 && attach.height >= 44 && attach.bottom <= innerHeight,
      size: window.__mobileFixture.terminalSize() }
  })
  const fit = async () => {
    await page.waitForFunction(() => {
      const viewport = document.querySelector('#viewport')
      const grid = viewport?.querySelector('.xterm-screen')?.getBoundingClientRect()
      const view = viewport?.getBoundingClientRect()
      return grid && grid.height > 0 && grid.bottom <= view.bottom - 7
    })
    const bounds = await geometry()
    assert.ok(bounds.bottom <= bounds.toolsTop - 7, JSON.stringify(bounds))
    assert.ok(bounds.attachVisible, JSON.stringify(bounds))
    return bounds
  }
  const selectSession = async id => {
    await page.click('#show-sessions', { label: 'open terminal session drawer' })
    await page.waitForSelector('#session-drawer[open]')
    await page.click(`#session-options [data-id="${id}"] .row`, { label: 'switch terminal session' })
    await page.waitForFunction(() => !document.querySelector('#session-drawer').open
      && document.querySelector('#terminal-status').textContent === '会话中')
  }
  try {
    await page.goto(baseUrl + '/mobile-android/')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
      localStorage.setItem('qingcode:mobile:image-compression', 'original')
    })
    await page.reload()
    await metrics(390, 844)
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'show project list' })
    await page.click('#project-list .row:first-child', { label: 'open terminal project' })
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await step('collapsing and expanding keeps the final terminal row above the tools', async () => {
      const expanded = await fit()
      await page.click('#toggle-keys', { label: 'collapse terminal shortcut keys' })
      await page.waitForFunction(rows => window.__mobileFixture.terminalSize().rows > rows, expanded.size.rows)
      const collapsed = await fit()
      await page.evaluate(({ rows, cols }) => window.__mobileFixture.pushScreen('mobile-1',
        `\x1b[2J\x1b[H\x1b[${rows};1HBOTTOM-VISIBLE`, cols, rows), collapsed.size)
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('BOTTOM-VISIBLE'))
      await fit()
      await page.screenshot({ path: resolve(output, 'collapsed-bottom-visible.png') })
      await page.click('#toggle-keys', { label: 'expand terminal shortcut keys' })
      await page.waitForFunction(rows => window.__mobileFixture.terminalSize().rows < rows, collapsed.size.rows)
      await fit()
    })
    await step('narrow, keyboard-height and landscape layouts retain full rows and the image button', async () => {
      for (const [width, height, name] of [[320, 640, 'narrow'], [390, 400, 'keyboard'], [844, 390, 'landscape']]) {
        await metrics(width, height)
        await page.evaluate(value => window.qingOrientation(value), width > height && width > 600)
        await fit()
        await page.screenshot({ path: resolve(output, name + '.png') })
      }
      await metrics(390, 844)
      await page.evaluate(() => window.qingOrientation(false))
      await fit()
    })
    await step('multiple originals are read and uploaded sequentially and only inserted into the draft', async () => {
      await page.fill('#compose', '请分析这几张图片 ')
      await page.evaluate(() => {
        const state = window.__mobileFixture.state
        state.image = [1, 2, 3].map(value => ({ data: btoa(String.fromCharCode(255, 216, 255, value)) }))
        state.imagePaths = [1, 2, 3].map(value => `'/tmp/photo-${value}.jpg'`)
        state.imageDelay = 250
      })
      await page.click('#attach-image', { label: 'select multiple original photos' })
      await page.waitForFunction(() => window.__mobileFixture.state.imageReads.length === 1
        && window.__mobileFixture.state.images.length === 0)
      assert.ok(await page.evaluate(() => document.querySelector('#attach-image').disabled
        && document.querySelector('#expanded-attach').disabled))
      await page.waitForFunction(() => window.__mobileFixture.state.images.length === 3)
      await settled()
      assert.deepEqual(await page.evaluate(() => ({
        reads: window.__mobileFixture.state.imageReads, inputs: window.__mobileFixture.state.inputs,
        mode: window.__mobileFixture.state.imageCompression, draft: document.querySelector('#compose').value,
      })), { reads: [0, 1, 2], inputs: [], mode: 'original',
        draft: "请分析这几张图片 '/tmp/photo-1.jpg' '/tmp/photo-2.jpg' '/tmp/photo-3.jpg' " })
      await page.screenshot({ path: resolve(output, 'multiple-images-in-draft.png') })
    })
    await step('a failed second image preserves the first and releases the native selection', async () => {
      await page.fill('#compose', '保留说明 ')
      await page.evaluate(() => {
        const state = window.__mobileFixture.state
        state.images = []; state.imageReads = []; state.imageDelay = 0
        state.image = [{ data: btoa('first') }, { error: '图片不能超过 8 MB' }, { data: btoa('third') }]
      })
      await page.click('#attach-image', { label: 'upload batch with oversized photo' })
      await page.waitForSelector('#image-dialog[open]')
      await settled()
      assert.match(await page.evaluate(() => document.querySelector('#image-error').textContent), /1\/3.*8 MB/)
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.imageReads), [0, 1])
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), "保留说明 '/tmp/photo-1.jpg' ")
      await page.screenshot({ path: resolve(output, 'partial-failure.png') })
      await page.click('#image-dialog [data-close]', { label: 'close partial upload error' })
    })
    await step('cancelling multi-selection preserves the draft and uploads nothing', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.image = [] })
      await page.click('#attach-image', { label: 'cancel photo multi selection' })
      await settled()
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.images.length), 1)
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), "保留说明 '/tmp/photo-1.jpg' ")
    })
    await step('switching sessions stops the remaining batch and ignores the late result', async () => {
      await page.click('#new-session', { label: 'add another terminal session' })
      await page.click('[data-profile="default"]', { label: 'create a shell session' })
      await page.waitForFunction(() => window.__mobileFixture.state.sessions.size === 2
        && document.querySelector('#terminal-status').textContent === '会话中')
      await page.fill('#compose', '另一会话草稿 ')
      await page.evaluate(() => {
        const state = window.__mobileFixture.state
        state.imageReads = []; state.imageDelay = 0
        state.imageGate = new Promise(resolve => { state.releaseImage = resolve })
        state.image = [{ data: btoa('one') }, { data: btoa('two') }]
      })
      await page.click('#attach-image', { label: 'start batch before switching sessions' })
      await page.waitForFunction(() => window.__mobileFixture.state.imageReads.length === 1)
      await selectSession('mobile-1')
      await page.evaluate(() => {
        const state = window.__mobileFixture.state
        state.imageGate = null
        state.releaseImage()
      })
      await settled()
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.imageReads), [0])
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), "保留说明 '/tmp/photo-1.jpg' ")
      await selectSession('mobile-2')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '另一会话草稿 ')
    })
    await step('single-image bridges continue to work', async () => {
      await page.evaluate(() => {
        const state = window.__mobileFixture.state
        state.image = { data: btoa('legacy') }; state.imageDelay = 0; state.imagePaths = null
      })
      await page.click('#attach-image', { label: 'upload a legacy single image' })
      await settled()
      assert.match(await page.evaluate(() => document.querySelector('#compose').value), /mobile-image\.jpg/)
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, results }, null, 2))
    if (finish) await task.finish({ keep: [] })
    console.log(JSON.stringify({ output, results }, null, 2))
  } catch (error) {
    results.push({ passed: false, error: String(error) })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, spaceId: task.spaceId, results }, null, 2))
    throw error
  }
}
