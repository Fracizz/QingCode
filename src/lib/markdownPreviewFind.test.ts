// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  collectTextSegments,
  findTextMatches,
  isMarkdownPreviewFindTarget,
  rangeForMatch,
} from './markdownPreviewFind'

const plain = { caseSensitive: false, wholeWord: false, regexp: false }

describe('findTextMatches', () => {
  it('默认不区分大小写并转义特殊字符', () => {
    expect(findTextMatches('a.b A.B axb', 'a.b', plain)).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ])
  })

  it('区分大小写与全字匹配', () => {
    expect(findTextMatches('Foo foo food', 'foo', { ...plain, caseSensitive: true })).toEqual([
      { from: 4, to: 7 },
      { from: 8, to: 11 },
    ])
    expect(findTextMatches('foo food foo', 'foo', { ...plain, wholeWord: true })).toEqual([
      { from: 0, to: 3 },
      { from: 9, to: 12 },
    ])
  })

  it('支持中文查找', () => {
    expect(findTextMatches('是高性能服务器管理面板', '能服务器管', plain)).toEqual([{ from: 3, to: 8 }])
  })

  it('正则无效返回 null，零长度匹配被跳过', () => {
    expect(findTextMatches('abc', '(', { ...plain, regexp: true })).toBeNull()
    expect(findTextMatches('aab', 'a*', { ...plain, regexp: true })).toEqual([{ from: 0, to: 2 }])
  })

  it('空查询无结果', () => {
    expect(findTextMatches('abc', '', plain)).toEqual([])
  })
})

describe('rangeForMatch', () => {
  it('匹配可以跨越多个文本节点', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>NEM<strong>运维平台</strong>是高性能</p>'
    const segments = collectTextSegments(root)
    expect(segments.text).toBe('NEM运维平台是高性能')
    const [match] = findTextMatches(segments.text, 'M运维', plain) ?? []
    const range = rangeForMatch(segments, match)
    expect(range?.toString()).toBe('M运维')
    expect(range?.endContainer.textContent).toBe('运维平台')
    expect(range?.endOffset).toBe(2)
  })

  it('匹配正好在节点末尾时终点不落到下一个节点', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span>ab</span><span>cd</span>'
    const segments = collectTextSegments(root)
    const range = rangeForMatch(segments, { from: 0, to: 2 })
    expect(range?.endContainer.textContent).toBe('ab')
    expect(range?.toString()).toBe('ab')
  })
})

describe('isMarkdownPreviewFindTarget', () => {
  it('焦点在预览窗格内或仅预览模式下的 body 时为真', () => {
    document.body.innerHTML =
      '<div class="qing-md-preview-pane"><div class="qing-md-preview" id="p"></div></div><div id="o"></div>'
    expect(isMarkdownPreviewFindTarget(document.getElementById('p'))).toBe(true)
    expect(isMarkdownPreviewFindTarget(document.getElementById('o'))).toBe(false)
    expect(isMarkdownPreviewFindTarget(document.body)).toBe(false)
    document.querySelector('.qing-md-preview-pane')?.setAttribute('data-preview-only', 'true')
    expect(isMarkdownPreviewFindTarget(document.body)).toBe(true)
  })
})
