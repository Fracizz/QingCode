import { create } from 'zustand'

/**
 * 多端共享的终端状态（来自 Rust 的 `terminal-control` 事件）。所有端默认都能输入；
 * 被设备独占时电脑只读；尺寸跟随最后一次键盘输入的一方，电脑不是尺寸方时网格跟随对方。
 * 不持久化，窗口重载后由 `mobile_terminal_controls` 恢复。
 */
export interface TerminalShareViewer {
  id: string | null
  kind: 'desktop' | 'device'
  name: string
  observe: boolean
  typing: boolean
}

export interface TerminalControl {
  rev: number
  /** 非空表示被这台设备独占，电脑暂时不能输入。 */
  blockedBy: string | null
  cols: number
  rows: number
  viewers: TerminalShareViewer[]
  sizeOwner: string
  sizeOwnerIsDesktop: boolean
  sizeLocked: boolean
  exclusive: string | null
  exclusiveIsDesktop: boolean
  lastInput: { name: string; kind: 'desktop' | 'device'; at: number } | null
}

/** Rust 发来的原始载荷，见 src-tauri/src/mobile/hub.rs 的 `control_payload`。 */
export interface TerminalControlPayload {
  id: string
  rev?: number
  removed?: boolean
  controller?: string | null
  cols?: number
  rows?: number
  viewers?: TerminalShareViewer[]
  sizeOwner?: string
  sizeOwnerKind?: 'desktop' | 'device'
  sizeLocked?: boolean
  exclusive?: string | null
  exclusiveKind?: 'desktop' | 'device' | null
  lastInput?: { name: string; kind: 'desktop' | 'device'; at: number } | null
  mirroring?: boolean
}

interface TerminalControlState {
  controls: Record<string, TerminalControl>
  setControl: (id: string, control: TerminalControl) => void
  clearControl: (id: string) => void
}

export const useTerminalControlStore = create<TerminalControlState>(set => ({
  controls: {},
  setControl: (id, control) => set(state => ({ controls: { ...state.controls, [id]: control } })),
  clearControl: id =>
    set(state => {
      if (!state.controls[id]) return state
      const controls = { ...state.controls }
      delete controls[id]
      return { controls }
    }),
}))

/** 把载荷转成界面状态；没有设备参与（无设备在线、无独占、电脑是尺寸方）时返回 null。 */
export function parseTerminalControl(payload: TerminalControlPayload): TerminalControl | null {
  if (payload.removed) return null
  const viewers = payload.viewers ?? []
  const control: TerminalControl = {
    rev: payload.rev ?? 0,
    blockedBy: payload.controller ?? null,
    cols: payload.cols ?? 80,
    rows: payload.rows ?? 24,
    viewers,
    sizeOwner: payload.sizeOwner ?? '',
    sizeOwnerIsDesktop: (payload.sizeOwnerKind ?? 'desktop') === 'desktop',
    sizeLocked: payload.sizeLocked ?? false,
    exclusive: payload.exclusive ?? null,
    exclusiveIsDesktop: payload.exclusiveKind === 'desktop',
    lastInput: payload.lastInput ?? null,
  }
  const shared = viewers.some(viewer => viewer.kind === 'device')
    || control.exclusive !== null
    || !control.sizeOwnerIsDesktop
    || control.blockedBy !== null
  return shared ? control : null
}

/** 应用一条共享状态；编号更旧的载荷直接丢弃。 */
export function applyTerminalControlPayload(payload: TerminalControlPayload) {
  const store = useTerminalControlStore.getState()
  const previous = store.controls[payload.id]
  if (previous && payload.rev !== undefined && payload.rev < previous.rev) return
  const control = parseTerminalControl(payload)
  if (control) store.setControl(payload.id, control)
  else store.clearControl(payload.id)
}

export function terminalControl(id: string): TerminalControl | undefined {
  return useTerminalControlStore.getState().controls[id]
}

/** 被设备独占：电脑暂时不能输入。 */
export function isTerminalInputBlocked(id: string): boolean {
  return !!terminalControl(id)?.blockedBy
}

/** 其他设备是尺寸方：电脑的网格跟随对方，窗口变化只报给后端记下。 */
export function terminalFollowsRemoteGrid(id: string): TerminalControl | undefined {
  const control = terminalControl(id)
  return control && !control.sizeOwnerIsDesktop ? control : undefined
}
