import { describe, expect, it } from 'vitest'
import { mergeSessionList } from '../../mobile/android/web/protocol.js'

describe('Android session list metadata reconciliation', () => {
  const session = (id: string, revision: number, programBusy: boolean, name = '⠋ Building') => ({
    id, name, programTitle: name, customName: null, nameRevision: revision, activityRevision: revision, programBusy, exit: null,
  })

  it('retains newer poll activity and raw title when a delayed list arrives', () => {
    const previous = session('mobile-1', 3, false, '✳ Ready')
    const [merged] = mergeSessionList([session('mobile-1', 2, true)], [previous])
    expect(merged).toMatchObject({ name: '✳ Ready', programTitle: '✳ Ready', programBusy: false, activityRevision: 3 })
  })

  it('accepts fresh activity even when the name revision has not changed', () => {
    const previous = session('mobile-1', 2, true)
    const fresh = { ...session('mobile-1', 4, false), nameRevision: 2 }
    const [merged] = mergeSessionList([fresh], [previous])
    expect(merged).toMatchObject({ programBusy: false, activityRevision: 4, name: '⠋ Building' })
  })

  it('uses the returned member set and never resurrects removed sessions or exited processes', () => {
    const ended = { ...session('mobile-1', 2, false), exit: { exitCode: 0 } }
    const result = mergeSessionList([session('mobile-1', 1, true), session('mobile-3', 0, false)], [ended, session('mobile-2', 2, true)])
    expect(result.map(item => item.id)).toEqual(['mobile-1', 'mobile-3'])
    expect(result[0].exit).toEqual({ exitCode: 0 })
    expect(result[0].programBusy).toBe(false)
  })

  it('retains compatibility with old servers without explicit activity fields', () => {
    const previous = { id: 'mobile-1', name: 'Manual', customName: 'Manual', nameRevision: 2 }
    const [merged] = mergeSessionList([{ id: 'mobile-1', name: 'Old', nameRevision: 1 }], [previous])
    expect(merged.name).toBe('Manual')
    expect(merged.programBusy).toBeUndefined()
  })
})
