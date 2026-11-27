/** 桥接层对客户端返回的 JSON-RPC 错误；独立成文件避免 bridge 与输入解析互相依赖。 */
export class BridgeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeRpcError'
  }
}
