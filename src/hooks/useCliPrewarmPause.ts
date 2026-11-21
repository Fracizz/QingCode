import { useEffect, useState } from 'react'
import { safeInvoke } from '../lib/tauri'

type PrewarmStatus = { profile?: { reason?: string | null } }

/** 设置页打开期间刷新 CLI 预热状态的间隔。 */
const POLL_MS = 3000

/**
 * 依次查询候选目录的预热状态，返回第一个带 CLI 预热目标的暂停原因；
 * 没有 CLI 预热目标或正常运行时返回 null。
 */
export async function readCliPrewarmPause(cwds: readonly string[]): Promise<string | null> {
  for (const cwd of cwds) {
    try {
      const status = await safeInvoke<PrewarmStatus>('读取 CLI 预热状态', 'shell_prewarm_status', { cwd })
      if (status?.profile) return status.profile.reason ?? null
    } catch {
      // 浏览器预览或命令不可用时不显示状态。
    }
  }
  return null
}

/** 轮询 CLI 预热的暂停原因；enabled 为 false（未选 CLI 配置）时不查询。 */
export function useCliPrewarmPause(cwds: readonly string[], enabled: boolean): string | null {
  const [reason, setReason] = useState<string | null>(null)
  const key = cwds.join('\n')
  useEffect(() => {
    if (!enabled || !key) return
    let cancelled = false
    const list = key.split('\n')
    const poll = () => {
      void readCliPrewarmPause(list).then(next => {
        if (!cancelled) setReason(next)
      })
    }
    poll()
    const timer = window.setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      setReason(null)
    }
  }, [enabled, key])
  return enabled ? reason : null
}
