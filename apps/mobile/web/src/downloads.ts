// 项目文件下载的完成提示：下载由原生前台服务在后台进行，这里在应用层轮询状态，
// 关掉文件页、切到别的页面也能在完成时给一条提示。纯逻辑（downloadOutcome）与轮询分开。
import { t, translateMessage } from '@qn/codex-client'
import { callDevice } from './client'
import type { DeviceDownload } from './projectApi'
import { toast, type ToastTone } from './toast'

/** 下载结束时给用户的提示；进行中与用户主动取消不提示。 */
export function downloadOutcome(job: DeviceDownload): { message: string; tone: ToastTone } | null {
  if (job.state === 'done') {
    const name = job.savedName ?? job.name
    return { message: job.auto ? t('已下载 {name}，保存在 下载/QingCode', { name }) : t('已下载 {name}', { name }), tone: 'ok' }
  }
  if (job.state === 'failed') {
    return { message: job.error ? t('{name} 下载失败：{reason}', { name: job.name, reason: translateMessage(job.error) }) : t('{name} 下载失败', { name: job.name }), tone: 'error' }
  }
  return null
}

const POLL_MS = 1000
// 连续读不到状态（原生端重启、桥断开）时放弃，系统通知栏仍会显示结果。
const MAX_MISSES = 10
const watching = new Set<string>()

type Poll = (id: string) => Promise<DeviceDownload | null>
const devicePoll: Poll = (id) => callDevice<DeviceDownload | null>('download.status', { id })

/** 盯住一个下载直到结束，结束时弹一次提示；同一个下载重复调用只盯一次。 */
export function watchDownload(id: string, poll: Poll = devicePoll, notify = (job: DeviceDownload) => {
  const outcome = downloadOutcome(job)
  if (outcome) toast(outcome.message, { tone: outcome.tone })
}): void {
  if (watching.has(id)) return
  watching.add(id)
  let misses = 0
  const tick = () => {
    poll(id).then((job) => {
      if (job && job.id === id && job.state !== 'running') {
        watching.delete(id)
        notify(job)
        return
      }
      misses = job ? 0 : misses + 1
      if (misses >= MAX_MISSES) watching.delete(id)
      else setTimeout(tick, POLL_MS)
    }, () => {
      misses += 1
      if (misses >= MAX_MISSES) watching.delete(id)
      else setTimeout(tick, POLL_MS)
    })
  }
  setTimeout(tick, POLL_MS)
}
