// 不依赖任何模块的错误文本工具，供 store 与各类错误格式化函数共用（避免引入依赖环）。

/** Normalize Tauri / Error payloads into a plain message string. */
export function formatInvokeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error:\s*/i, '').trim() || raw
}
