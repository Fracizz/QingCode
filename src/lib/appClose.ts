import { getCurrentWindow } from '@tauri-apps/api/window'
import { choiceDialog } from '../store/choiceStore'
import { useEditorStore } from '../store/editorStore'
import { pauseTerminalSpawnsForExit, resumeTerminalSpawnsAfterExit, useTerminalStore } from '../store/terminalStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'
import { isTransferActive, useTransferStore } from '../store/transferStore'
import { closeTerminalOnExit, finishRemoteTerminalOnExit } from './ipc/terminal'
import { runAppClose } from './appCloseFlow'
import { flushWorkspaceSessionPersist } from './workspaceSessionSync'
import { safeInvoke } from './tauri'

let closing: Promise<void> | undefined

/** All native close/menu/command entry points share one in-flight decision. */
export function requestAppClose(): Promise<void> {
  if (closing) return closing
  closing = runAppClose({
    pauseSpawns: pauseTerminalSpawnsForExit,
    resumeSpawns: resumeTerminalSpawnsAfterExit,
    terminals: () => useTerminalStore.getState().terminals,
    transferCount: () => useTransferStore.getState().tasks.filter(task => isTransferActive(task.status)).length,
    choose: choiceDialog,
    confirmFiles: () => confirmDiscardTabs(useEditorStore.getState().getAllTabs(), '退出应用'),
    finishRemote: (tab, action) => finishRemoteTerminalOnExit({
      id: tab.id, ptyId: tab.ptyId!, cwd: tab.cwd, action,
    }),
    closeTerminal: closeTerminalOnExit,
    markEnded: tab => useTerminalStore.setState(state => ({ terminals: state.terminals.map(current =>
      current.id === tab.id && current.ptyId === tab.ptyId
        ? { ...current, status: 'exited', endedAt: tab.cwd.startsWith('ssh://') ? Date.now() : undefined,
          awaitingRestoreSpawn: false, ptySpawnPending: false }
        : current,
    ) })),
    markDetached: tab => useTerminalStore.setState(state => ({ terminals: state.terminals.map(current =>
      current.id === tab.id && current.ptyId === tab.ptyId && !current.endedAt
        ? { ...current, status: 'exited', awaitingRestoreSpawn: true, ptySpawnPending: true }
        : current,
    ) })),
    flush: flushWorkspaceSessionPersist,
    destroy: async () => {
      const window = getCurrentWindow()
      if (window.label === 'main') await safeInvoke('关闭移动连接', 'mobile_stop')
      await window.destroy()
    },
  }).finally(() => { closing = undefined })
  return closing
}
