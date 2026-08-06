import { describe, expect, it } from 'vitest'
import {
  getPerformanceDiagnosticsSnapshot,
  recordLongTask,
  recordPerformanceThroughput,
  recordTauriCommandDuration,
} from './performanceDiagnostics'

describe('performanceDiagnostics', () => {
  it('records long tasks, slow commands, terminal bytes, and file events', () => {
    const before = getPerformanceDiagnosticsSnapshot()
    recordLongTask(250)
    recordTauriCommandDuration('scan_directory', 275, true)
    recordPerformanceThroughput('terminalBytes', 4096)
    recordPerformanceThroughput('fsEvents', 2)
    const after = getPerformanceDiagnosticsSnapshot()

    expect(after.longTasks.count).toBe(before.longTasks.count + 1)
    expect(after.tauriCommands.slowCount).toBe(before.tauriCommands.slowCount + 1)
    expect(after.tauriCommands.recentSlow.at(-1)?.command).toBe('scan_directory')
    expect(after.rates.terminalBytesPerSecond).toBeGreaterThan(0)
    expect(after.rates.fsEventsPerSecond).toBeGreaterThan(0)
  })
})
