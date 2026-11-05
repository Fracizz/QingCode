import { describe, expect, it } from 'vitest'
import { findLinks, lineLinks, linkContains, logicalLine, phoneLink } from '../../mobile/android/web/terminalLinks.js'

// 模拟 xterm buffer：每行固定列数，宽字符占两格（第二格宽度为 0）。
function buffer(rows: Array<{ text: string; wrapped?: boolean }>, cols = 20) {
  const lines = rows.map(({ text, wrapped = false }) => {
    const cells: Array<{ chars: string; width: number }> = []
    for (const char of text) {
      const wide = /[一-鿿]/.test(char)
      cells.push({ chars: char, width: wide ? 2 : 1 })
      if (wide) cells.push({ chars: '', width: 0 })
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 })
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x: number) => ({ getChars: () => cells[x].chars, getWidth: () => cells[x].width }),
    }
  })
  return { getLine: (y: number) => lines[y] }
}

describe('Android terminal links', () => {
  it('finds http(s) links and trims trailing punctuation', () => {
    expect(findLinks('Local: http://localhost:5173/ ready')).toEqual([{ start: 7, end: 29, url: 'http://localhost:5173/' }])
    expect(findLinks('PR：https://github.com/a/b/pull/12。').map(link => link.url)).toEqual(['https://github.com/a/b/pull/12'])
    expect(findLinks('(see https://example.com/x).').map(link => link.url)).toEqual(['https://example.com/x'])
    expect(findLinks('https://en.wikipedia.org/wiki/A_(b)').map(link => link.url)).toEqual(['https://en.wikipedia.org/wiki/A_(b)'])
    expect(findLinks('ftp://x http:// `https://a.dev`')).toEqual([{ start: 17, end: 30, url: 'https://a.dev' }])
  })

  it('rewrites loopback addresses to the computer for local and WSL projects', () => {
    const local = phoneLink('http://localhost:5173/app?x=1', { computerHost: '192.168.1.8', projectKind: 'local' })
    expect(local.open).toBe('http://192.168.1.8:5173/app?x=1')
    expect(local.note).toMatch(/局域网/)
    expect(phoneLink('http://127.0.0.1:3000', { computerHost: '10.0.0.2', projectKind: 'wsl' }).open).toBe('http://10.0.0.2:3000/')
    expect(phoneLink('http://0.0.0.0:8080/', { computerHost: '10.0.0.2' }).open).toBe('http://10.0.0.2:8080/')
    expect(phoneLink('http://[::1]:8080/', { computerHost: '10.0.0.2' }).open).toBe('http://10.0.0.2:8080/')
  })

  it('keeps public links and refuses to open remote-only loopback addresses', () => {
    expect(phoneLink('https://github.com/x/y/pull/3', { computerHost: '10.0.0.2', projectKind: 'ssh' }))
      .toEqual({ url: 'https://github.com/x/y/pull/3', open: 'https://github.com/x/y/pull/3', note: '' })
    const remote = phoneLink('http://localhost:5173/', { computerHost: '10.0.0.2', projectKind: 'ssh' })
    expect(remote.open).toBeNull()
    expect(remote.note).toMatch(/远端/)
    expect(phoneLink('http://localhost:1/', { projectKind: 'local' }).open).toBeNull()
  })

  it('maps links to cells across wide characters', () => {
    const lines = buffer([{ text: '中文 http://a.io/x' }])
    expect(logicalLine(lines, 0).text.startsWith('中文 http')).toBe(true)
    // 「中文」占 4 列，空格 1 列，链接从第 6 列（1 起始）开始。
    expect(lineLinks(lines, 0)).toEqual([{ url: 'http://a.io/x', range: { start: { x: 6, y: 1 }, end: { x: 18, y: 1 } } }])
  })

  it('joins soft-wrapped rows so a long URL is one link from either row', () => {
    const lines = buffer([
      { text: 'go https://example.c' },
      { text: 'om/very/long', wrapped: true },
      { text: 'next line' },
    ])
    const expected = [{ url: 'https://example.com/very/long', range: { start: { x: 4, y: 1 }, end: { x: 12, y: 2 } } }]
    expect(lineLinks(lines, 0)).toEqual(expected)
    expect(lineLinks(lines, 1)).toEqual(expected)
    expect(lineLinks(lines, 2)).toEqual([])
  })

  it('tests whether a 0-based cell lies inside a multi-row range', () => {
    const range = { start: { x: 4, y: 1 }, end: { x: 12, y: 2 } }
    expect(linkContains(range, 3, 0)).toBe(true)
    expect(linkContains(range, 2, 0)).toBe(false)
    expect(linkContains(range, 0, 1)).toBe(true)
    expect(linkContains(range, 12, 1)).toBe(false)
    expect(linkContains(range, 5, 2)).toBe(false)
  })
})
