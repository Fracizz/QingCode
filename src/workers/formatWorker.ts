/**
 * Format Worker - 在 Web Worker 中执行大文件格式化
 *
 * 使用场景：
 * - 大文件（> 5MB）格式化时避免阻塞主线程
 * - 长耗时格式化操作的后台处理
 */

export interface FormatWorkerRequest {
  id: number
  path: string
  content: string
  maxSize: number
}

export interface FormatWorkerResponse {
  id: number
  success: boolean
  result?: string
  error?: string
}

// 模拟格式化逻辑（实际项目中会调用真实的格式化工具）
function simulateFormat(content: string): string {
  // 这里可以集成 prettier、rustfmt 等格式化工具
  // 目前作为示例，返回去除多余空行的简单格式化
  return content
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

self.onmessage = (event: MessageEvent<FormatWorkerRequest>) => {
  const { id, path, content, maxSize } = event.data

  try {
    // 检查文件大小
    if (content.length > maxSize) {
      self.postMessage({
        id,
        success: false,
        error: `文件过大（>${maxSize} 字符），无法在 Worker 中格式化`,
      } as FormatWorkerResponse)
      return
    }

    // 执行格式化
    const startTime = performance.now()
    const result = simulateFormat(content)
    const endTime = performance.now()

    // 记录格式化耗时
    console.log(`[FormatWorker] 格式化完成: ${path}, 耗时: ${(endTime - startTime).toFixed(2)}ms`)

    self.postMessage({
      id,
      success: true,
      result,
    } as FormatWorkerResponse)
  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } as FormatWorkerResponse)
  }
}

export {}