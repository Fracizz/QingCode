import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import test from 'node:test'

test('native queues isolate uploads, bound work, cancel expired inputs and ignore late replies', () => {
  const root = resolve(import.meta.dirname, '..')
  const output = mkdtempSync(join(tmpdir(), 'qingcode-native-'))
  const executable = name => process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name
  try {
    execFileSync(executable('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-d', output,
      join(root, 'mobile/android/NativeRequests.java'), join(root, 'mobile/tests/NativeRequestsTest.java')], { timeout: 30_000, windowsHide: true })
    const result = execFileSync(executable('java'), ['-cp', output, 'com.qingcode.companion.NativeRequestsTest'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.match(result, /6 native scheduler regressions passed/)
  } finally {
    assert.equal(dirname(resolve(output)), resolve(tmpdir()))
    assert.ok(basename(output).startsWith('qingcode-native-'))
    rmSync(output, { recursive: true, force: true })
  }
})
