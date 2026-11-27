import { getLocale, t } from '@qn/codex-client'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 侧栏行尾用的紧凑相对时间：刚刚 / 5 分钟 / 3 小时 / 2 天，超过一周显示日期。 */
export function formatRelative(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = now - ms
  // 远端时钟略快时可能出现未来时间，按"刚刚"处理。
  if (diff < MINUTE) return t('刚刚')
  // 行尾空间窄，英文用单字母单位；这类短模板不进词典。
  const en = getLocale() === 'en'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}${en ? 'm' : ' 分钟'}` // i18n-ignore: 紧凑时长单位
  if (diff < DAY) return `${Math.floor(diff / HOUR)}${en ? 'h' : ' 小时'}` // i18n-ignore: 紧凑时长单位
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}${en ? 'd' : ' 天'}` // i18n-ignore: 紧凑时长单位
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const md = `${date.getMonth() + 1}/${date.getDate()}`
  if (sameYear) return md
  return en ? `${md}/${date.getFullYear()}` : `${date.getFullYear()}/${md}`
}
