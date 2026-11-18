import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import test from 'node:test'

test('native queues isolate uploads, bound work, cancel expired inputs and ignore late replies; update URLs stay on GitHub / Gitee', () => {
  const root = resolve(import.meta.dirname, '..')
  const output = mkdtempSync(join(tmpdir(), 'qingcode-native-'))
  const executable = name => process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name
  try {
    execFileSync(executable('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-d', output,
      join(root, 'mobile/android/NativeRequests.java'), join(root, 'mobile/tests/NativeRequestsTest.java'),
      join(root, 'mobile/android/OutputFrameWindow.java'), join(root, 'mobile/tests/OutputFrameWindowTest.java'),
      join(root, 'mobile/android/UpdatePolicy.java'), join(root, 'mobile/tests/UpdatePolicyTest.java'),
      join(root, 'mobile/android/WatchPolicy.java'), join(root, 'mobile/tests/WatchPolicyTest.java'),
      join(root, 'mobile/android/FileDownloadPolicy.java'), join(root, 'mobile/tests/FileDownloadPolicyTest.java')], { timeout: 30_000, windowsHide: true })
    const result = execFileSync(executable('java'), ['-cp', output, 'com.qingcode.companion.NativeRequestsTest'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.match(result, /7 native scheduler regressions passed/)
    execFileSync(executable('java'), ['-cp', output, 'com.qingcode.companion.OutputFrameWindowTest'],
      { timeout: 20_000, windowsHide: true })
    const update = execFileSync(executable('java'), ['-cp', output, 'com.qingcode.companion.UpdatePolicyTest'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.match(update, /[1-9]\d* update policy regressions passed/)
    const watch = execFileSync(executable('java'), ['-cp', output, 'com.qingcode.companion.WatchPolicyTest'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.match(watch, /7 watch policy regressions passed/)
    const download = execFileSync(executable('java'), ['-cp', output, 'com.qingcode.companion.FileDownloadPolicyTest'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.match(download, /8 file download regressions passed/)
  } finally {
    assert.equal(dirname(resolve(output)), resolve(tmpdir()))
    assert.ok(basename(output).startsWith('qingcode-native-'))
    rmSync(output, { recursive: true, force: true })
  }
})

test('every desktop op the web layer sends is allowed by the native bridge', () => {
  const root = resolve(import.meta.dirname, '..')
  const web = join(root, 'mobile/android/web')
  const source = readdirSync(web).filter(name => name.endsWith('.js'))
    .map(name => readFileSync(join(web, name), 'utf8')).join('\n')
  // remote('op', …) 直接发出的，以及 shareAction('op', …) 转发给 remote 的。
  const sent = new Set([...source.matchAll(/\b(?:remote|shareAction)\('([a-z_]+)'/g)].map(match => match[1]))
  const activity = readFileSync(join(root, 'mobile/android/MainActivity.java'), 'utf8')
  const block = activity.match(/request\.remove\("profile"\);\s*switch \(op\) \{([\s\S]*?)default:/)
  assert.ok(block, 'MainActivity 中找不到桌面 op 白名单')
  const allowed = new Set([...block[1].matchAll(/case "([a-z_]+)"/g)].map(match => match[1]))
  for (const op of ['exclusive', 'take_size', 'attach']) assert.ok(sent.has(op), `未扫描到网页层发出的 ${op}`)
  const missing = [...sent].filter(op => !allowed.has(op))
  assert.deepEqual(missing, [], `原生白名单缺少：${missing.join(', ')}`)
})
