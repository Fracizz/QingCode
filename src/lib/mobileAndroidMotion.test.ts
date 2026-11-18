import { describe, expect, it } from 'vitest'
import { pageDirection, rippleRadius } from '../../mobile/android/web/motion.js'

describe('Android 界面动效辅助', () => {
  it('按底部导航顺序决定页面滑入方向', () => {
    expect(pageDirection('home', 'project')).toBe('forward')
    expect(pageDirection('home', 'connection')).toBe('forward')
    expect(pageDirection('connection', 'project')).toBe('back')
    expect(pageDirection('project', 'home')).toBe('back')
  })

  it('同一页、从终端返回或未知页面原地淡入', () => {
    expect(pageDirection('project', 'project')).toBe('none')
    expect(pageDirection(null, 'home')).toBe('none')
    expect(pageDirection('settings', 'home')).toBe('none')
  })

  it('涟漪半径覆盖到离触点最远的角', () => {
    expect(rippleRadius(0, 0, 300, 40)).toBe(Math.ceil(Math.hypot(300, 40)))
    expect(rippleRadius(150, 20, 300, 40)).toBe(Math.ceil(Math.hypot(150, 20)))
    expect(rippleRadius(290, 35, 300, 40)).toBe(Math.ceil(Math.hypot(290, 35)))
  })
})
