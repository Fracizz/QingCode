import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  nextSemanticRevision,
  semanticContentWithinLimit,
  semanticUsageQueryInput,
  utf8ByteOffsetAt,
} from './semanticNavigation'

describe('utf8ByteOffsetAt', () => {
  it('converts CodeMirror UTF-16 positions to Tree-sitter UTF-8 byte offsets', () => {
    const state = EditorState.create({ doc: 'a中😀z' })

    expect(utf8ByteOffsetAt(state, 0)).toBe(0)
    expect(utf8ByteOffsetAt(state, 1)).toBe(1)
    expect(utf8ByteOffsetAt(state, 2)).toBe(4)
    expect(utf8ByteOffsetAt(state, 4)).toBe(8)
    expect(utf8ByteOffsetAt(state, 5)).toBe(9)
  })

  it('clamps positions to the document bounds', () => {
    const state = EditorState.create({ doc: '中文' })

    expect(utf8ByteOffsetAt(state, -10)).toBe(0)
    expect(utf8ByteOffsetAt(state, 99)).toBe(6)
  })
})

describe('nextSemanticRevision', () => {
  it('stays above old zero-based overlay revisions and increases monotonically', () => {
    const first = nextSemanticRevision()
    const second = nextSemanticRevision()

    expect(first).toBeGreaterThan(1_000_000_000_000)
    expect(second).toBe(first + 1)
  })
})

describe('semanticUsageQueryInput', () => {
  it('maps usage filters before backend pagination', () => {
    expect(semanticUsageQueryInput({ filter: 'write', offset: 200, maxResults: 100 })).toEqual({
      offset: 200,
      maxResults: 100,
      usageKinds: ['write', 'member-write', 'read-write', 'member-read-write'],
      approximateOnly: false,
    })
    expect(semanticUsageQueryInput({ filter: 'approximate' })).toEqual({
      offset: 0,
      maxResults: 200,
      usageKinds: undefined,
      approximateOnly: true,
    })
  })
})

describe('semanticContentWithinLimit', () => {
  it('uses UTF-8 bytes and rejects content above the backend overlay limit', () => {
    expect(semanticContentWithinLimit('a'.repeat(1024 * 1024))).toBe(true)
    expect(semanticContentWithinLimit('a'.repeat(1024 * 1024 + 1))).toBe(false)
    expect(semanticContentWithinLimit('中'.repeat(400_000))).toBe(false)
  })
})
