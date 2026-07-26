import { describe, expect, it } from 'vitest'
import type { DefinitionCandidate } from './definitionNavigation'
import { groupUsageCandidates } from './usageGrouping'

function usage(overrides: Partial<DefinitionCandidate>): DefinitionCandidate {
  return {
    name: 'processOrder',
    kind: 'function',
    path: 'D:/work/order.ts',
    relative: 'order.ts',
    line: 1,
    column: 1,
    text: 'processOrder(order)',
    score: 1000,
    usageKind: 'call',
    ...overrides,
  }
}

describe('groupUsageCandidates', () => {
  it('groups call sites by caller and file while keeping approximate results separate', () => {
    const groups = groupUsageCandidates([
      usage({ line: 10, callerName: 'submitOrder', callerKind: 'function' }),
      usage({ line: 20, callerName: 'submitOrder', callerKind: 'function' }),
      usage({
        path: 'D:/work/retry.ts',
        relative: 'retry.ts',
        line: 8,
        callerName: 'submitOrder',
        callerKind: 'function',
      }),
      usage({
        line: 30,
        callerName: 'submitOrder',
        callerKind: 'function',
        approximate: true,
      }),
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({
      callerName: 'submitOrder',
      relative: 'order.ts',
      approximate: false,
    })
    expect(groups[0].candidates.map(candidate => candidate.line)).toEqual([10, 20])
    expect(groups[2]).toMatchObject({
      callerName: 'submitOrder',
      approximate: true,
    })
  })

  it('falls back to one group per file for reads outside a named caller', () => {
    const groups = groupUsageCandidates([
      usage({ usageKind: 'read', callerName: undefined, line: 3 }),
      usage({ usageKind: 'read', callerName: undefined, line: 7 }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      callerName: undefined,
      relative: 'order.ts',
    })
    expect(groups[0].candidates).toHaveLength(2)
  })
})
