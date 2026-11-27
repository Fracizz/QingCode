/** 对客户端返回的 JSON-RPC 错误；与 claude 桥的错误类型分开，避免适配器互相耦合。 */
export class PiRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'PiRpcError'
  }
}
