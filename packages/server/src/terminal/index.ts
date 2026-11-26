// term.* 处理函数登记与 daemon 级终端管理器单例。
import type { WorkspaceHandlers } from '../workspace/registry'
import type { PtyBackendResolver } from './backend'
import {
  parseAttachParams,
  parseOpenParams,
  parseResizeParams,
  parseSnapshotParams,
  parseTermId,
  parseWriteParams,
} from './logic'
import { TerminalManager } from './manager'

export type { PtyBackendImpl, PtyBackendResolver, PtyExit, PtyProcess, PtySpawnOptions } from './backend'
export { createDefaultResolver } from './posix'
export { TerminalManager } from './manager'

let manager: TerminalManager | null = null

/** 一个 daemon 进程一份：终端跨连接存活，必须挂在进程级而不是连接级。 */
export function terminalManager(): TerminalManager {
  manager ??= new TerminalManager()
  return manager
}

/** T31 接入 Windows ConPTY 的入口：daemon 启动早期调用一次。 */
export function setPtyBackendResolver(resolver: PtyBackendResolver): void {
  terminalManager().setResolver(resolver)
}

/** 测试钩子：替换单例（传 null 重置）。 */
export function setTerminalManagerForTest(next: TerminalManager | null): void {
  manager = next
}

export const terminalHandlers: WorkspaceHandlers = {
  'term.open': async (p, ctx) => terminalManager().open(parseOpenParams(p), ctx),
  'term.write': async (p) => {
    const { termId, data } = parseWriteParams(p)
    return terminalManager().write(termId, data)
  },
  'term.resize': async (p, ctx) => {
    const { termId, cols, rows } = parseResizeParams(p)
    return terminalManager().resize(termId, cols, rows, ctx)
  },
  'term.close': async (p) => terminalManager().close(parseTermId(p.termId, 'term.close')),
  'term.attach': async (p, ctx) => {
    const { termId, sinceSeq } = parseAttachParams(p)
    return terminalManager().attach(termId, sinceSeq, ctx)
  },
  'term.detach': async (p, ctx) => terminalManager().detach(parseTermId(p.termId, 'term.detach'), ctx),
  'term.snapshot': async (p) => {
    const { termId, ...snapshot } = parseSnapshotParams(p)
    return terminalManager().snapshot(termId, snapshot)
  },
  'term.list': async () => terminalManager().list(),
}
