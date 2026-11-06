// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
// Android 端语言切换即时生效：静态文案需能在中英之间来回重译，且不改动终端画面。
import { EN, setLocale, translateDocument } from '../../mobile/android/web/i18n.js'

afterEach(() => setLocale('zh'))

function mount() {
  document.body.innerHTML = `
    <h1> 终端 </h1>
    <button id="connect" data-i18n="action:connect">连接</button>
    <input id="search" placeholder="清除搜索">
    <div class="xterm"><span>终端</span></div>
    <span id="late"></span>
  `
}

describe('Android translateDocument', () => {
  it('switches static text between Chinese and English repeatedly', () => {
    mount()
    setLocale('en')
    translateDocument(document.body)
    expect(document.querySelector('h1')?.textContent).toBe(` ${EN['终端']} `)
    expect(document.getElementById('connect')?.textContent).toBe(EN['action:connect'])
    expect(document.getElementById('search')?.getAttribute('placeholder')).toBe(EN['清除搜索'])

    setLocale('zh')
    translateDocument(document.body)
    expect(document.querySelector('h1')?.textContent).toBe(' 终端 ')
    expect(document.getElementById('connect')?.textContent).toBe('连接')
    expect(document.getElementById('search')?.getAttribute('placeholder')).toBe('清除搜索')

    setLocale('en')
    translateDocument(document.body)
    expect(document.getElementById('connect')?.textContent).toBe(EN['action:connect'])
  })

  it('leaves terminal output untouched', () => {
    mount()
    setLocale('en')
    translateDocument(document.body)
    expect(document.querySelector('.xterm span')?.textContent).toBe('终端')
  })

  it('restores English text generated after startup back to Chinese', () => {
    mount()
    setLocale('en')
    translateDocument(document.body)
    document.getElementById('late')!.textContent = EN['重新读取']
    setLocale('zh')
    translateDocument(document.body)
    expect(document.getElementById('late')?.textContent).toBe('重新读取')
  })
})
