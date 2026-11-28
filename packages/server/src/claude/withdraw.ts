/** 停止时撤回仍在 CLI 队列里、尚未开始处理的消息。 */

/**
 * cancelAsyncMessage 由 SDK 运行时（sdk.mjs）提供，公开类型 sdk.d.ts 的 Query 未声明。
 * 它是经用户批准的唯一非公开接口例外（docs/tasks/T40-paseo-alignment.md），类型扩展只放在这里。
 * 升级 SDK 时须确认它仍然存在；缺失时调用方沿用公开 interrupt() 加二次中断。
 */
type WithCancelAsyncMessage = { cancelAsyncMessage?: (uuid: string) => Promise<unknown> }

// 停止操作不能被撤回请求拖住。
const WITHDRAW_TIMEOUT_MS = 2000

/** 返回确认撤回的 UUID；方法缺失、返回 false、抛错或超时的都不在其中。 */
export async function withdrawMessages(
  query: object,
  ids: readonly string[],
  onError: (error: unknown) => void,
  timeoutMs = WITHDRAW_TIMEOUT_MS,
): Promise<string[]> {
  const { cancelAsyncMessage } = query as WithCancelAsyncMessage
  if (!cancelAsyncMessage || ids.length === 0) return []
  const results = await Promise.all(ids.map(async (id) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const cancelled = await Promise.race([
        cancelAsyncMessage.call(query, id),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
      ])
      return cancelled === true ? id : null
    } catch (error) {
      onError(error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }))
  return results.filter((id) => id !== null)
}
