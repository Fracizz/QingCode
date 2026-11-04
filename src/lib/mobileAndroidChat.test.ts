import { describe, expect, it } from 'vitest'
import {
  chatSupported,
  collectAnswers,
  diffLineKind,
  formatTokens,
  inlineTokens,
  markdownBlocks,
  mergeItems,
  prependItems,
  quotaWindows,
  relativeTime,
  resetLabel,
  resetTime,
  safetyOption,
  sortThreads,
  threadStatus,
  threadTitle,
  usageSummary,
} from '../../mobile/android/web/chatModel.js'

describe('Android 对话条目合并', () => {
  it('增量更新按 id 替换并追加新条目', () => {
    const current = [{ id: 'a', rev: 1, text: 'x' }, { id: 'b', rev: 2 }]
    const merged = mergeItems(current, [{ id: 'a', rev: 3, text: 'xy' }, { id: 'c', rev: 4 }], false)
    expect(merged.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(merged[0].text).toBe('xy')
    expect(mergeItems(current, [], false)).toBe(current)
  })

  it('完整同步以服务端窗口为准，保留窗口之前已加载的历史', () => {
    const current = [{ id: 'old' }, { id: 'a' }, { id: 'b' }]
    expect(mergeItems(current, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], true).map(item => item.id)).toEqual(['old', 'a', 'b', 'c'])
    expect(mergeItems(current, [{ id: 'x' }], true).map(item => item.id)).toEqual(['x'])
  })

  it('历史分页前置且去重', () => {
    expect(prependItems([{ id: 'b' }, { id: 'c' }], [{ id: 'a' }, { id: 'b' }]).map(item => item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('Android 对话状态文案', () => {
  it('待审批优先于运行状态', () => {
    expect(threadStatus({ status: 'running', pending: 2 })).toEqual({ label: '等待审批 2', tone: 'warn' })
    expect(threadStatus({ status: 'running', pending: 0 }).label).toBe('执行中')
    expect(threadStatus({ status: 'closed', pending: 0 }).label).toBe('已暂停')
    expect(threadStatus({ status: 'error', pending: 0 }).tone).toBe('error')
    expect(threadTitle({ title: '  ' })).toBe('新对话')
  })

  it('列表把待审批与执行中的对话排在前面', () => {
    const sorted = sortThreads([
      { id: 'idle-new', status: 'idle', pending: 0, updatedAt: 9 },
      { id: 'running', status: 'running', pending: 0, updatedAt: 1 },
      { id: 'waiting', status: 'running', pending: 1, updatedAt: 0 },
      { id: 'idle-old', status: 'idle', pending: 0, updatedAt: 2 },
    ])
    expect(sorted.map(thread => thread.id)).toEqual(['waiting', 'running', 'idle-new', 'idle-old'])
  })

  it('相对时间与令牌数格式', () => {
    const now = Date.UTC(2026, 10, 4, 12)
    expect(relativeTime(now - 20_000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 小时前')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(24_000)).toBe('24k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('用量摘要显示上下文占用与花费', () => {
    expect(usageSummary({ contextUsed: 50_000, contextWindow: 200_000, cost: { amount: 0.0123, currency: 'USD' } })).toBe('上下文 25% · $0.012')
    expect(usageSummary({ contextUsed: 3000 })).toBe('上下文 3k')
    expect(usageSummary(null)).toBe('')
  })
})

describe('Android 额度', () => {
  it('统一 Unix 秒与 ISO 重置时间', () => {
    expect(resetTime(1_800_000_000)).toBe(1_800_000_000_000)
    expect(resetTime('2026-11-04T18:49:59Z')).toBe(Date.parse('2026-11-04T18:49:59Z'))
    expect(resetTime('')).toBeNull()
    const now = Date.parse('2026-11-04T12:00:00Z')
    expect(resetLabel('2026-11-04T12:30:00Z', now)).toBe('30 分钟后重置')
    expect(resetLabel('2026-11-04T14:15:00Z', now)).toBe('2 小时 15 分后重置')
    expect(resetLabel('2026-11-04T11:00:00Z', now)).toBe('即将重置')
  })

  it('窗口按占用标记颜色并限制在 0–100', () => {
    const windows = quotaWindows({ windows: [{ label: '5 小时', percent: 22 }, { label: '每周', percent: 95.4 }, { label: '坏数据', percent: null }] })
    expect(windows.map(window => [window.label, window.percent, window.tone])).toEqual([['5 小时', 22, 'ok'], ['每周', 95, 'error']])
  })

  it('按 Agent 查找安全选项', () => {
    const catalog = [{ id: 'codex', safety: [{ id: 'full', full: true }] }]
    expect(safetyOption(catalog, 'codex', 'full')?.full).toBe(true)
    expect(safetyOption(catalog, 'claude', 'full')).toBeNull()
  })
})

describe('Android 对话 Markdown', () => {
  it('解析标题、列表、代码块、引用与分隔线', () => {
    const blocks = markdownBlocks('# 标题\n说明第一行\n第二行\n\n- 一\n- [x] 完成\n  续行\n1. 甲\n\n```rust\nfn main() {}\n```\n> 引用\n---')
    expect(blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule'])
    expect(blocks[1].text).toBe('说明第一行\n第二行')
    expect(blocks[2].items[1]).toEqual({ text: '完成\n续行', depth: 0, checked: true })
    expect(blocks[3].ordered).toBe(true)
    expect(blocks[4]).toEqual({ type: 'code', lang: 'rust', text: 'fn main() {}' })
  })

  it('未闭合的代码块保留到结尾（流式输出）', () => {
    expect(markdownBlocks('看这里\n```js\nconst a = 1')).toEqual([
      { type: 'paragraph', text: '看这里' },
      { type: 'code', lang: 'js', text: 'const a = 1' },
    ])
  })

  it('行内标记只接受安全链接', () => {
    expect(inlineTokens('运行 `pnpm test` 后**提交**，见 [文档](https://a.dev/x) 或 https://b.dev/y。')).toEqual([
      { type: 'text', text: '运行 ' },
      { type: 'code', text: 'pnpm test' },
      { type: 'text', text: ' 后' },
      { type: 'bold', text: '提交' },
      { type: 'text', text: '，见 ' },
      { type: 'link', text: '文档', href: 'https://a.dev/x' },
      { type: 'text', text: ' 或 ' },
      { type: 'link', text: 'https://b.dev/y', href: 'https://b.dev/y' },
      { type: 'text', text: '。' },
    ])
    expect(inlineTokens('[x](javascript:alert(1))')[0]).toEqual({ type: 'text', text: 'x' })
  })

  it('diff 行分类', () => {
    expect(['+a', '-b', '@@ -1 +1 @@', '+++ b/x', ' c'].map(diffLineKind)).toEqual(['add', 'remove', 'hunk', 'meta', 'context'])
  })
})

describe('Android 对话可用的项目', () => {
  it('本机、WSL 与 Linux 远端可以对话，Windows 远端只支持终端', () => {
    expect(chatSupported({ kind: 'local', path: 'D:\\code\\a' })).toBe(true)
    expect(chatSupported({ kind: 'wsl', path: '\\\\wsl.localhost\\Ubuntu\\home\\a' })).toBe(true)
    expect(chatSupported({ kind: 'ssh', path: 'ssh://conn-1/srv/api' })).toBe(true)
    expect(chatSupported({ kind: 'ssh', path: 'ssh://conn-2/C:/work/api' })).toBe(false)
    expect(chatSupported({ kind: 'ssh', path: 'ssh://conn-2/D:' })).toBe(false)
    expect(chatSupported(null)).toBe(false)
  })
})

describe('Android 提问卡片', () => {
  it('合并选项与自定义回答，跳过空回答', () => {
    const questions = [{ id: 'q1', question: '用哪个库？' }, { question: '备注？' }, { id: 'q3' }]
    const selections = new Map([['q1', new Set(['A'])]])
    const others = new Map([['q1', ' 自定义 '], ['备注？', '无'], ['q3', '  ']])
    expect(collectAnswers(questions, selections, others)).toEqual({ q1: ['A', '自定义'], '备注？': ['无'] })
  })
})
