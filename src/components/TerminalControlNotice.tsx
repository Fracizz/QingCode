import { useState } from 'react'
import { Lock, LockOpen, Maximize2, ShieldCheck, ShieldOff } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import {
  setTerminalExclusive,
  setTerminalSizeLock,
  takeTerminalSizeForDesktop,
} from '@/lib/ipc/mobileSessions'
import { useProjectStore } from '@/store/projectStore'
import { useTerminalControlStore, type TerminalControl } from '@/store/terminalControlStore'
import Tooltip from './Tooltip'

const BUTTON_CLASS =
  'inline-flex min-h-[var(--ui-control-height)] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-brand/10 px-2.5 font-medium text-brand hover:bg-brand/20 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50'

type Translate = ReturnType<typeof useI18n>['t']

/** 共享状态的一行说明：谁独占、几台设备在看、谁在输入、按谁的尺寸显示。 */
function describeTerminalControl(control: TerminalControl, t: Translate): string {
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

/**
 * 多端共享终端时显示在标签底部。所有端都能输入；电脑可以独占、锁定尺寸，
 * 或在其他设备是尺寸方时改回按电脑窗口显示。被设备独占时电脑只读，可解除对方的独占。
 */
export default function TerminalControlNotice({ terminalId }: { terminalId: string }) {
  const { t } = useI18n()
  const control = useTerminalControlStore(s => s.controls[terminalId])
  const [busy, setBusy] = useState(false)
  if (!control) return null
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      useProjectStore.getState().pushToast('error', String(error))
    } finally {
      setBusy(false)
    }
  }
  const exclusiveButton = control.blockedBy || control.exclusiveIsDesktop
    ? {
        label: t('解除独占'),
        tip: control.blockedBy
          ? t('解除「{name}」的独占，所有设备都能输入', { name: control.blockedBy })
          : t('所有设备都能输入'),
        icon: <ShieldOff size={14} aria-hidden="true" />,
        action: () => setTerminalExclusive(terminalId, false, true),
      }
    : {
        label: t('独占'),
        tip: t('只允许电脑输入，其他设备只读'),
        icon: <ShieldCheck size={14} aria-hidden="true" />,
        action: () => setTerminalExclusive(terminalId, true),
      }
  return (
    <div
      role="status"
      data-testid="terminal-control-notice"
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-bg-deep px-3 py-1 text-ui-sm"
    >
      <span className="min-w-0 flex-1 wrap-anywhere text-fg-muted">{describeTerminalControl(control, t)}</span>
      {!control.sizeOwnerIsDesktop && !control.blockedBy && (
        <Tooltip label={t('终端改为按电脑窗口的行列显示')} side="top">
          <button type="button" disabled={busy} className={BUTTON_CLASS}
            onClick={() => void run(() => takeTerminalSizeForDesktop(terminalId))}>
            <Maximize2 size={14} aria-hidden="true" />
            {t('按电脑尺寸')}
          </button>
        </Tooltip>
      )}
      {!control.blockedBy && (
        <Tooltip label={control.sizeLocked ? t('恢复为跟随最后输入的一方') : t('固定当前尺寸，打字不再切换')} side="top">
          <button type="button" disabled={busy} className={BUTTON_CLASS}
            onClick={() => void run(() => setTerminalSizeLock(terminalId, !control.sizeLocked))}>
            {control.sizeLocked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
            {control.sizeLocked ? t('解锁尺寸') : t('锁定尺寸')}
          </button>
        </Tooltip>
      )}
      <Tooltip label={exclusiveButton.tip} side="top">
        <button type="button" disabled={busy} className={BUTTON_CLASS}
          onClick={() => void run(exclusiveButton.action)}>
          {exclusiveButton.icon}
          {exclusiveButton.label}
        </button>
      </Tooltip>
    </div>
  )
}
