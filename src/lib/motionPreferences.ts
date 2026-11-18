/** 应用内「界面动效」偏好，存在本机，与颜色主题一样在首帧前生效（main.tsx）。 */
export const MOTION_SETTINGS_KEY = 'qingcode:motion'

/** system：跟随系统「减少动画」；reduce：应用内额外减少。应用内不能在系统已减少时强制开启。 */
export type MotionPreference = 'system' | 'reduce'

export const DEFAULT_MOTION_PREFERENCE: MotionPreference = 'system'

export const MOTION_PREFERENCES: { label: string; value: MotionPreference }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '减少动效', value: 'reduce' },
]

export function loadMotionPreference(): MotionPreference {
  try {
    if (localStorage.getItem(MOTION_SETTINGS_KEY) === 'reduce') return 'reduce'
  } catch {}
  return DEFAULT_MOTION_PREFERENCE
}

/** 写入 html[data-motion="reduce"]，animations.css 与 exitMotion.ts 都认它。 */
export function applyMotionPreference(preference: MotionPreference) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (preference === 'reduce') root.dataset.motion = 'reduce'
  else delete root.dataset.motion
}

export function saveMotionPreference(preference: MotionPreference) {
  try {
    if (preference === 'reduce') localStorage.setItem(MOTION_SETTINGS_KEY, 'reduce')
    else localStorage.removeItem(MOTION_SETTINGS_KEY)
  } catch {}
  applyMotionPreference(preference)
}

/** 多窗口共用本机存储：另一个窗口改了偏好时同步到本窗口。 */
export function startMotionPreferenceSync() {
  if (typeof window === 'undefined') return
  window.addEventListener('storage', event => {
    if (event.key === MOTION_SETTINGS_KEY) applyMotionPreference(loadMotionPreference())
  })
}

/** 系统「减少动画」或应用内「减少动效」任一开启即减少；每次重新判断，不缓存系统设置。 */
export function motionReduced(): boolean {
  if (typeof document !== 'undefined' && document.documentElement?.dataset.motion === 'reduce') return true
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Explicit JS scrolling must also respect the motion preference. */
export function preferredScrollBehavior(): ScrollBehavior {
  return motionReduced() ? 'auto' : 'smooth'
}
