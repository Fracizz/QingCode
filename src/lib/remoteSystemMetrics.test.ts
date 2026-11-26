// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_METRICS_INTERVAL,
  formatMetricBytes,
  memoryPercent,
  parseRemoteSystemMetrics,
  readRemoteMetricsInterval,
  usageLevel,
  writeRemoteMetricsInterval,
} from './remoteSystemMetrics'

describe('remoteSystemMetrics', () => {
  beforeEach(() => localStorage.clear())

  it('parses and clamps a server snapshot', () => {
    expect(parseRemoteSystemMetrics({
      cpuThreads: 8, cpuCores: 0, cpuBaseMhz: 2400, cpuUsage: 140, memoryTotal: 100, memoryUsed: 120,
    })).toEqual({ cpuThreads: 8, cpuCores: null, cpuBaseMhz: 2400, cpuUsage: 100, memoryTotal: 100, memoryUsed: 100 })
  })

  it('rejects snapshots without CPU or memory totals', () => {
    expect(parseRemoteSystemMetrics(null)).toBeNull()
    expect(parseRemoteSystemMetrics({ cpuThreads: 4, memoryTotal: 0 })).toBeNull()
    expect(parseRemoteSystemMetrics({ cpuThreads: Number.NaN, memoryTotal: 10 })).toBeNull()
  })

  it('formats bytes, percent and usage levels', () => {
    expect(formatMetricBytes(512)).toBe('512 B')
    expect(formatMetricBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatMetricBytes(34_359_738_368)).toBe('32 GB')
    expect(formatMetricBytes(10 * 1024 ** 3)).toBe('10 GB')
    expect(formatMetricBytes(15.7 * 1024 ** 3)).toBe('15.7 GB')
    expect(memoryPercent(1, 3)).toBe(33.3)
    expect(memoryPercent(1, 0)).toBe(0)
    expect([usageLevel(10), usageLevel(70), usageLevel(95)]).toEqual(['ok', 'warn', 'danger'])
  })

  it('persists only supported sampling intervals', () => {
    expect(readRemoteMetricsInterval()).toBe(DEFAULT_REMOTE_METRICS_INTERVAL)
    writeRemoteMetricsInterval(0)
    expect(readRemoteMetricsInterval()).toBe(0)
    localStorage.setItem('qingcode.remoteMetricsInterval', '7')
    expect(readRemoteMetricsInterval()).toBe(DEFAULT_REMOTE_METRICS_INTERVAL)
  })
})
