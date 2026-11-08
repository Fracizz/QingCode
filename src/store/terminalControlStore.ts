import { create } from 'zustand'

/** 其他设备正在使用的终端：电脑只读，并跟随对方的行列显示。不持久化，重启后自然清空。 */
export interface TerminalControl {
  name: string
  cols: number
  rows: number
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

export function terminalControl(id: string): TerminalControl | undefined {
  return useTerminalControlStore.getState().controls[id]
}
