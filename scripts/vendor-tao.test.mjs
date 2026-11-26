import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseArgs, selectPatches } from './vendor-tao.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const patchesDir = path.join(root, 'src-tauri/vendor/tao-patches')

test('parseArgs 解析版本、skip 与 check', () => {
  const o = parseArgs(['--version', '0.38.0', '--skip', '0001', '--check'])
  assert.equal(o.version, '0.38.0')
  assert.deepEqual(o.skip, ['0001'])
  assert.equal(o.check, true)
})

test('parseArgs 拒绝非法版本与未知参数', () => {
  assert.throws(() => parseArgs([]), /--version/)
  assert.throws(() => parseArgs(['--version', 'latest']), /--version/)
  assert.throws(() => parseArgs(['--version', '0.38.0', '--force']), /未知参数/)
})

test('selectPatches 按文件名排序并跳过指定前缀', () => {
  const files = ['0002-b.patch', '.gitattributes', '0001-a.patch']
  assert.deepEqual(selectPatches(files, []), ['0001-a.patch', '0002-b.patch'])
  assert.deepEqual(selectPatches(files, ['0001']), ['0002-b.patch'])
})

test('仓库内补丁文件存在且与 vendor/tao 当前内容一致', () => {
  const patches = selectPatches(readdirSync(patchesDir), [])
  assert.deepEqual(patches, ['0001-windows-runner-arc.patch', '0002-windows-reset-runner-leak-handler.patch'])
  const runner = readFileSync(path.join(root, 'src-tauri/vendor/tao/src/platform_impl/windows/event_loop/runner.rs'), 'utf8')
  assert.match(runner, /type EventLoopRunnerShared<T> = Arc<EventLoopRunner<T>>/)
  assert.match(runner, /mem::forget\(event_handler\.take\(\)\)/)
})
