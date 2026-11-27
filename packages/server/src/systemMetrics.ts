import { readFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { ServerResult } from '@qn/protocol'

type Metrics = ServerResult<'system.metrics'>
type CpuSample = { threads: number; idle: number; busy: number }

function sampleCpu(): CpuSample {
  const cores = cpus()
  let idle = 0
  let busy = 0
  for (const { times } of cores) {
    idle += times.idle
    busy += times.user + times.nice + times.sys + times.irq
  }
  return { threads: cores.length, idle, busy }
}

function cpuUsage(before: CpuSample, after: CpuSample): number | null {
  const idle = after.idle - before.idle
  const busy = after.busy - before.busy
  if (before.threads !== after.threads || idle < 0 || busy < 0 || idle + busy === 0) return null
  return 100 * busy / (idle + busy)
}

async function availableMemory(): Promise<number> {
  if (process.platform === 'linux') {
    // Linux 的空闲内存不含可回收的页缓存，MemAvailable 更接近还能使用的物理内存。
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)
    if (available) return Number(available[1]) * 1024
  }
  return freemem()
}

async function sampleMetrics(): Promise<Metrics> {
  const before = sampleCpu()
  // CPU 占用率取两次系统计数的差，首次读取也有一个完整的采样窗口。
  const [available] = await Promise.all([availableMemory(), delay(250)])
  const after = sampleCpu()
  const memoryTotal = totalmem()
  return {
    cpuThreads: after.threads,
    cpuUsage: cpuUsage(before, after),
    memoryUsed: Math.max(0, memoryTotal - available),
    memoryTotal,
  }
}

let pendingSample: Promise<Metrics> | undefined

export function readSystemMetrics(): Promise<Metrics> {
  // 同一台机器上的多个客户端可共用正在进行的采样。
  pendingSample ??= sampleMetrics().finally(() => { pendingSample = undefined })
  return pendingSample
}
