import { afterEach, describe, expect, it } from 'vitest'
import {
  discardSpawnInput,
  queueSpawnInput,
  SPAWN_INPUT_QUEUE_LIMIT,
  takeSpawnInput,
} from './spawnInputQueue'

afterEach(() => {
  discardSpawnInput('t1')
  discardSpawnInput('t2')
})

describe('spawnInputQueue', () => {
  it('replays queued input in order and clears it', () => {
    queueSpawnInput('t1', 'ls')
    queueSpawnInput('t1', ' -la')
    queueSpawnInput('t1', '\r')
    expect(takeSpawnInput('t1')).toBe('ls -la\r')
    expect(takeSpawnInput('t1')).toBe('')
  })

  it('keeps queues separate per terminal', () => {
    queueSpawnInput('t1', 'a')
    queueSpawnInput('t2', 'b')
    expect(takeSpawnInput('t2')).toBe('b')
    expect(takeSpawnInput('t1')).toBe('a')
  })

  it('rejects input beyond the limit but keeps what was already queued', () => {
    expect(queueSpawnInput('t1', 'x'.repeat(SPAWN_INPUT_QUEUE_LIMIT - 1))).toBe(true)
    expect(queueSpawnInput('t1', 'yy')).toBe(false)
    expect(queueSpawnInput('t1', 'z')).toBe(true)
    expect(takeSpawnInput('t1')).toHaveLength(SPAWN_INPUT_QUEUE_LIMIT)
  })

  it('drops queued input on discard', () => {
    queueSpawnInput('t1', 'echo hi\r')
    discardSpawnInput('t1')
    expect(takeSpawnInput('t1')).toBe('')
  })
})
