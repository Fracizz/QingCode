import type { WorkspaceErrorCode, WorkspaceMethod } from '@qn/protocol'

/** 文件/Git 处理函数抛出它，daemon 把 code 原样写进 res.error.code。 */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** 每个客户端连接一份；连接断开时 daemon 依次调用 onClose 登记的清理函数。 */
export interface WorkspaceContext {
  clientId: number
  resolveRg?(): Promise<string[]>
  /** 只发给本连接的 evt（fs.searchResult、fs.changed） */
  emit(name: string, payload: unknown): void
  onClose(cleanup: () => void): void
  log(message: string): void
}

export type WorkspaceHandler = (
  params: Record<string, unknown>,
  ctx: WorkspaceContext,
) => Promise<unknown>

export type WorkspaceHandlers = Partial<Record<WorkspaceMethod, WorkspaceHandler>>
