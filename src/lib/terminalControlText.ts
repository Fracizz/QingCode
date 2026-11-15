import type { TerminalControl } from '@/store/terminalControlStore'

/** 与 useI18n().t 同签名的翻译函数。 */
type Translate = (text: string, vars?: Record<string, string>) => string
export type TerminalControlTone = 'idle' | 'active' | 'notice'

/** 共享状态的完整说明：谁独占、几台设备在看、谁在输入、按谁的尺寸显示。 */
export function describeTerminalControl(control: TerminalControl, t: Translate): string {
  if (control.blockedBy) return t('「{name}」已独占，电脑只读', { name: control.blockedBy })
  const parts: string[] = []
  const devices = control.viewers.filter(viewer => viewer.kind === 'device')
  if (devices.length) {
    parts.push(devices.length === 1
      ? t('{name} 也在看', { name: devices[0].name })
      : t('另有 {count} 台设备在看', { count: String(devices.length) }))
  }
  const typing = control.viewers.find(viewer => viewer.typing && viewer.kind === 'device')
  if (typing) parts.push(t('{name} 正在输入', { name: typing.name }))
  if (control.exclusiveIsDesktop) parts.push(t('电脑已独占'))
  if (!control.sizeOwnerIsDesktop) parts.push(t('按 {name} 的尺寸显示', { name: control.sizeOwner }))
  if (control.sizeLocked) parts.push(t('尺寸已锁定'))
  return parts.join(' · ') || t('多端共享中')
}

/** 角标短文字与配色：被独占 / 对方输入中 / 跟随对方尺寸 / 电脑独占 / 谁在看。 */
export function terminalControlChip(control: TerminalControl, t: Translate): { label: string; tone: TerminalControlTone } {
  if (control.blockedBy) return { label: t('{name} 独占', { name: control.blockedBy }), tone: 'notice' }
  const devices = control.viewers.filter(viewer => viewer.kind === 'device')
  const typing = devices.find(viewer => viewer.typing)
  if (typing) return { label: t('{name} 输入中', { name: typing.name }), tone: 'active' }
  if (control.exclusiveIsDesktop) return { label: t('已独占'), tone: 'active' }
  if (!control.sizeOwnerIsDesktop) return { label: t('按 {name} 尺寸', { name: control.sizeOwner }), tone: 'notice' }
  if (devices.length === 1) return { label: devices[0].name, tone: 'idle' }
  return { label: devices.length ? String(devices.length) : t('多端共享中'), tone: 'idle' }
}
