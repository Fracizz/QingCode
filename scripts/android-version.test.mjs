import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { androidVersionCode } from './android-version.mjs'

test('android version codes increase across prerelease channels and stable', () => {
  const ordered = ['0.1.13', '0.1.14-alpha.3', '0.1.14-beta.1', '0.1.14-beta.22', '0.1.14-rc.1', '0.1.14', '0.2.0-beta.1', '1.0.0']
  const codes = ordered.map(androidVersionCode)
  for (let index = 1; index < codes.length; index += 1) {
    assert.ok(codes[index] > codes[index - 1], `${ordered[index]} should follow ${ordered[index - 1]}`)
  }
  assert.equal(androidVersionCode('0.1.14-beta.22'), 114_322)
  // Older companion builds used versionCode 4.
  assert.ok(androidVersionCode('0.1.14-beta.22') > 4)
})

test('android version codes reject unsupported versions', () => {
  for (const version of ['0.1', '0.1.14-dev.1', '0.1.100', '210.0.0', '0.1.14-beta.300']) {
    assert.throws(() => androidVersionCode(version), version)
  }
  assert.ok(androidVersionCode('209.99.99') <= 2_100_000_000)
})

test('android version CLI prints name and code', () => {
  const script = fileURLToPath(new URL('./android-version.mjs', import.meta.url))
  const output = JSON.parse(execFileSync(process.execPath, [script, '0.2.0'], { encoding: 'utf8' }))
  assert.deepEqual(output, { name: '0.2.0', code: 200_999 })
})
