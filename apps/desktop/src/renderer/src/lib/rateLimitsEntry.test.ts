import { describe, expect, it } from 'vitest'
import { entryFor, type RateLimitEntry } from './rateLimitsEntry'

const entry = (error: string): RateLimitEntry => ({
  snapshot: null,
  account: null,
  updatedAt: 1,
  loading: false,
  error,
  costByThread: {},
})

describe('按 agent 读取额度', () => {
  it('Codex 用 byTarget，Claude 用 byAgent，互不串数据', () => {
    const codex = entry('codex')
    const claude = entry('claude')
    const byTarget = { local: codex }
    const byAgent = { 'codex:local': codex, 'claude:local': claude }
    expect(entryFor(byTarget, byAgent, 'local', 'codex')).toBe(codex)
    expect(entryFor(byTarget, byAgent, 'local', 'claude')).toBe(claude)
    expect(entryFor(byTarget, byAgent, null, 'claude')).toBeUndefined()
    expect(entryFor({}, byAgent, 'local', 'codex')).toBe(codex)
  })
})
