import type { WorkspaceMethods } from '@qn/protocol'
import { call, on } from '../../lib/backend'

type Method = keyof WorkspaceMethods

/** 带类型的文件/Git 调用；失败抛 BackendCallError（code 为 WorkspaceErrorCode 或 backend 错误码）。 */
export async function serverCall<M extends Method>(
  targetId: string,
  method: M,
  params: WorkspaceMethods[M]['params'],
): Promise<WorkspaceMethods[M]['result']> {
  const result = await call('server.req', { targetId, method, params })
  return result as WorkspaceMethods[M]['result']
}

/** 订阅某目标的 server evt（如 fs.changed、fs.searchResult）；返回取消函数。 */
export function onServerEvt<T>(
  name: string,
  listener: (targetId: string, payload: T) => void,
): () => void {
  return on('server.evt', (evt) => {
    if (evt.name === name) listener(evt.targetId, evt.payload as T)
  })
}
