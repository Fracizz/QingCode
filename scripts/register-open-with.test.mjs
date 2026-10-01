import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('Open With preserves Windows and third-party associations across every lifecycle', {
  skip: process.platform !== 'win32' && 'Requires PowerShell on Windows.',
}, () => {
  const output = execFileSync('pwsh.exe', [
    '-NoProfile', '-File', fileURLToPath(new URL('./register-open-with.test.ps1', import.meta.url)),
  ], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
  assert.match(output, /PASS: registration/)
})

test('PowerShell and native registration agree on recommended and editor-only extensions', () => {
  const rust = readFileSync(new URL('../src-tauri/src/file_associations.rs', import.meta.url), 'utf8')
  const script = readFileSync(new URL('./register-open-with.ps1', import.meta.url), 'utf8')
  const recommended = [...rust.match(/const OPEN_WITH_EXTENSIONS:.*?= &\[(.*?)\];/s)[1].matchAll(/"([a-z0-9]+)"/g)].map(match => match[1])
  const editorOnly = [...rust.match(/const EDITOR_ONLY_EXTENSIONS:.*?= &\[(.*?)\];/s)[1].matchAll(/"([a-z0-9]+)"/g)].map(match => match[1])
  const allScript = [...script.match(/\$extensions = @\((.*?)\)/s)[1].matchAll(/'([a-z0-9]+)'/g)].map(match => match[1])
  const excludedScript = [...script.match(/\$editorOnlyExtensions = @\((.*?)\)/s)[1].matchAll(/'([a-z0-9]+)'/g)].map(match => match[1])
  assert.deepEqual(editorOnly.sort(), excludedScript.sort())
  assert.deepEqual(recommended.sort(), allScript.filter(ext => !excludedScript.includes(ext)).sort())
})
