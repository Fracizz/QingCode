import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Eye, Lock, LockOpen, Maximize2, ShieldCheck, ShieldOff, Unplug } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import {
  kickTerminalDevices,
  setTerminalExclusive,
  setTerminalSizeLock,
  takeTerminalSizeForDesktop,
} from '@/lib/ipc/mobileSessions'
import { useProjectStore } from '@/store/projectStore'
import { useTerminalControlStore } from '@/store/terminalControlStore'
import { describeTerminalControl, terminalControlChip, type TerminalControlTone } from '@/lib/terminalControlText'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import { useExitMotionRef } from '@/lib/exitMotion'

type Tone = TerminalControlTone

const TONE_CLASS: Record<Tone, string> = {
  idle: 'text-fg-muted',
  active: 'text-brand',
  notice: 'text-warn',
}

/**
 * 多端共享终端时叠在终端右上角的小角标：不占终端高度，设备加入或离开时终端不重排。
 * 悬停看完整说明，点开菜单可按电脑尺寸、锁定尺寸、独占/解除独占或断开其他端。
 * 被设备独占时电脑只读，可解除对方的独占。
 */
export default function TerminalControlNotice({ terminalId, offsetForSearch = false }: {
  terminalId: string
  offsetForSearch?: boolean
}) {
  const { t } = useI18n()
  const control = useTerminalControlStore(s => s.controls[terminalId])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [busy, setBusy] = useState(false)
  // 菜单打开时按下角标：菜单先因外部点击收起，随后的 click 不应再把它打开。
  const closingRef = useRef(false)
  // 共享结束时角标留下残影上移淡出（exitMotion 'float'）。
  const exitRef = useExitMotionRef<HTMLDivElement>('float')
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
  const chip = terminalControlChip(control, t)
  const hasDevices = control.viewers.some(viewer => viewer.kind === 'device')
  const items: ContextMenuItem[] = []
  if (!control.sizeOwnerIsDesktop && !control.blockedBy) {
    items.push({
      label: t('按电脑尺寸'),
      icon: <Maximize2 size={14} aria-hidden="true" />,
      action: () => run(() => takeTerminalSizeForDesktop(terminalId)),
    })
  }
  if (!control.blockedBy) {
    items.push({
      label: control.sizeLocked ? t('解锁尺寸') : t('锁定尺寸'),
      icon: control.sizeLocked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />,
      action: () => run(() => setTerminalSizeLock(terminalId, !control.sizeLocked)),
    })
  }
  items.push(control.blockedBy || control.exclusiveIsDesktop
    ? {
        label: t('解除独占'),
        icon: <ShieldOff size={14} aria-hidden="true" />,
        action: () => run(() => setTerminalExclusive(terminalId, false, true)),
      }
    : {
        label: t('独占'),
        hint: t('其他设备只读'),
        icon: <ShieldCheck size={14} aria-hidden="true" />,
        action: () => run(() => setTerminalExclusive(terminalId, true)),
      })
  if (hasDevices) {
    items.push({
      label: t('断开其他端'),
      icon: <Unplug size={14} aria-hidden="true" />,
      separatorBefore: true,
      action: () => run(() => kickTerminalDevices(terminalId)),
    })
  }
  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (closingRef.current) {
      closingRef.current = false
      return
    }
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ x: box.right, y: box.bottom + 4 })
  }
  return (
    <>
      <div ref={exitRef} className={`float-enter absolute right-3 z-10 ${offsetForSearch ? 'top-12' : 'top-2'}`}>
        <Tooltip label={describeTerminalControl(control, t)} side="bottom">
          <button
            type="button"
            data-testid="terminal-control-notice"
            aria-label={t('多端共享')}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            disabled={busy}
            onPointerDown={() => { closingRef.current = !!menu }}
            onMouseDown={event => event.stopPropagation()}
            onClick={openMenu}
            className={`inline-flex max-w-[12em] items-center gap-1 rounded-md border border-border bg-bg-deep/90 px-1.5 py-0.5 text-ui-sm shadow-sm hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50 ${TONE_CLASS[chip.tone]}`}
          >
            <Eye size={13} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{chip.label}</span>
          </button>
        </Tooltip>
      </div>
      {menu && (
        // 菜单经 portal 渲染，React 事件仍会冒泡到终端容器；拦下以免点菜单时把焦点抢回 xterm。
        <div onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
          <ContextMenu
            x={Math.max(8, menu.x - 220)}
            y={menu.y}
            items={items}
            onClose={() => setMenu(null)}
          />
        </div>
      )}
    </>
  )
}
