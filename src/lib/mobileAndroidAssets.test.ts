import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('packages and serves every module imported by the Android entry point', () => {
  const root = resolve(import.meta.dirname, '../..')
  const java = readFileSync(resolve(root, 'mobile/android/MainActivity.java'), 'utf8')
  const packaging = readFileSync(resolve(root, 'scripts/build-android.ps1'), 'utf8')
  const fixture = readFileSync(resolve(root, 'vite.web-test.config.ts'), 'utf8')
  const visited = new Set<string>()
  function visit(name: string) {
    if (visited.has(name)) return
    visited.add(name)
    const source = readFileSync(resolve(root, 'mobile/android/web', name), 'utf8')
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+\.js)['"]/g)) visit(match[1])
  }
  visit('app.js')
  for (const name of visited) {
    expect(java, `Android WebView must allow ${name}`).toContain(`case "${name}":`)
    expect(packaging, `APK must contain ${name}`).toContain(`'${name}'`)
    expect(fixture, `Browser fixture must serve ${name}`).toContain(`'${name}':`)
  }
})
