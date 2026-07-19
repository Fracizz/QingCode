export const ACTIVITY_BAR_HIDDEN_KEY = 'qingcode:activity-bar-hidden'

export function loadActivityBarHidden(): boolean {
  try {
    return localStorage.getItem(ACTIVITY_BAR_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function saveActivityBarHidden(hidden: boolean) {
  try {
    localStorage.setItem(ACTIVITY_BAR_HIDDEN_KEY, hidden ? '1' : '0')
  } catch {
    // ignore quota / private mode
  }
}
