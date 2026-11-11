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

it('packages and serves the pre-paint theme script loaded from index.html', () => {
  const root = resolve(import.meta.dirname, '../..')
  const html = readFileSync(resolve(root, 'mobile/android/web/index.html'), 'utf8')
  const java = readFileSync(resolve(root, 'mobile/android/MainActivity.java'), 'utf8')
  const packaging = readFileSync(resolve(root, 'scripts/build-android.ps1'), 'utf8')
  const fixture = readFileSync(resolve(root, 'vite.web-test.config.ts'), 'utf8')
  // 同步脚本须在 app.css 之后、app.js 之前，首帧前就写入 data-theme。
  expect(html).toContain('<script src="themeBoot.js"></script>')
  expect(html.indexOf('themeBoot.js')).toBeGreaterThan(html.indexOf('href="app.css"'))
  expect(html.indexOf('themeBoot.js')).toBeLessThan(html.indexOf('src="app.js"'))
  expect(java).toContain('case "themeBoot.js":')
  expect(packaging).toContain("'themeBoot.js'")
  expect(fixture).toContain("'themeBoot.js':")
})

it('loads the offline symbol font with a matching preload, CSP, MIME type, and bundled license', () => {
  const root = resolve(import.meta.dirname, '../..')
  const html = readFileSync(resolve(root, 'mobile/android/web/index.html'), 'utf8')
  const java = readFileSync(resolve(root, 'mobile/android/MainActivity.java'), 'utf8')
  const packaging = readFileSync(resolve(root, 'scripts/build-android.ps1'), 'utf8')
  const fixture = readFileSync(resolve(root, 'vite.web-test.config.ts'), 'utf8')
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]
  expect(csp).toBeDefined()
  expect(csp?.split(';').map(directive => directive.trim())).toContain("font-src 'self'")
  const preload = /<link\b[^>]*rel="preload"[^>]*>/.exec(html)?.[0]
  expect(preload).toBeDefined()
  expect(preload).toContain('href="qingcode-symbols.woff2"')
  expect(preload).toContain('as="font"')
  expect(preload).toContain('type="font/woff2"')
  expect(preload).toContain('crossorigin="anonymous"')
  expect(html.indexOf(preload!)).toBeLessThan(html.indexOf('src="app.js"'))
  expect(java).toContain('case "qingcode-symbols.woff2": type = "font/woff2"; break;')
  expect(java).toContain('type.equals("font/woff2") ? null : "UTF-8"')
  expect(java).toContain('case "qingcode-symbols-OFL.txt": type = "text/plain"; break;')
  expect(fixture).toContain("'qingcode-symbols.woff2': ['mobile/android/web/qingcode-symbols.woff2', 'font/woff2']")
  for (const asset of ['qingcode-symbols.woff2', 'qingcode-symbols-OFL.txt']) {
    expect(packaging, `APK must contain ${asset}`).toContain(`'${asset}'`)
    expect(readFileSync(resolve(root, 'mobile/android/web', asset)).length).toBeGreaterThan(0)
  }
  const license = readFileSync(resolve(root, 'mobile/android/web/qingcode-symbols-OFL.txt'), 'utf8')
  expect(license).toContain('Copyright 2022 The Noto Project Authors')
  expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1')
  expect(license).toContain('PERMISSION & CONDITIONS')
  expect(license).toContain('TERMINATION')
  expect(license).toContain('DISCLAIMER')
  expect(license.trimEnd()).toMatch(/OTHER DEALINGS IN THE FONT SOFTWARE\.$/)
})
