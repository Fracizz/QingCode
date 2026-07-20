import { describe, expect, it } from 'vitest'
import {
  buildRunningMapsFromTerminals,
  isActiveRunTerminal,
} from './runConfigStore'

describe('run config runtime helpers', () => {
  it('treats awaitingRestoreSpawn as active even when status is exited', () => {
    expect(
      isActiveRunTerminal({ status: 'exited', awaitingRestoreSpawn: true }),
    ).toBe(true)
    expect(
      isActiveRunTerminal({ status: 'exited', awaitingRestoreSpawn: false }),
    ).toBe(false)
    expect(isActiveRunTerminal({ status: 'running' })).toBe(true)
  })

  it('builds running maps from stamped terminals', () => {
    const { runningByTask, runningConfigs } = buildRunningMapsFromTerminals([
      { id: 't1', runConfigId: 'cfg', runTaskId: 'a' },
      { id: 't2', runConfigId: 'cfg', runTaskId: 'b' },
      { id: 'plain' },
    ])
    expect(runningByTask).toEqual({
      'cfg:a': 't1',
      'cfg:b': 't2',
    })
    expect(runningConfigs.cfg).toEqual(['cfg:a', 'cfg:b'])
  })
})
