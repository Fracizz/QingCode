# T1 协议包 packages/protocol

范围：只改 `packages/protocol/src/**`。

依据：`docs/mvp.md` §4。实现以下导出（`src/index.ts` 汇总导出），Node 与浏览器都要能用的部分不得依赖 Node 内置模块（帧编解码用 `Uint8Array`/`TextEncoder`/`DataView`；`attachFramedStream` 可以用 Node 类型）。

```ts
export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

// 帧
export function encodeFrame(msg: unknown): Uint8Array        // 4 字节大端长度 + UTF-8 JSON；超限抛 FrameError('oversize')
export class FrameDecoder { push(chunk: Uint8Array): unknown[] } // 支持任意切分/粘包；超限或 JSON 错误抛 FrameError
export class FrameError extends Error { readonly code: 'oversize' | 'json' }

// JSON-RPC（codex app-server 用的是不带 "jsonrpc":"2.0" 字段的 JSON-RPC 变体，两种都要接受）
export type JsonRpcId = number | string
export type JsonRpcRequest = { id: JsonRpcId; method: string; params?: unknown }
export type JsonRpcNotification = { method: string; params?: unknown }
export type JsonRpcResponse = { id: JsonRpcId; result: unknown } | { id: JsonRpcId; error: { code: number; message: string; data?: unknown } }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
export function classifyJsonRpc(msg: unknown): 'request' | 'notification' | 'response' | 'invalid'

// 线协议消息：Hello / Welcome / Req / Res / Evt / CodexSend / CodexRecv / ErrorMsg，字段严格按 mvp.md §4
export type ClientMessage = ...
export type ServerMessage = ...
export function parseClientMessage(x: unknown): ClientMessage | null   // 结构校验，不合法返回 null
export function parseServerMessage(x: unknown): ServerMessage | null

// req 方法类型表（mvp.md §4 的方法表），供两端获得类型安全
export interface ServerMethods {
  ping: { params: void; result: { serverVersion: string; protocol: number } }
  'fs.home': ...; 'fs.list': ...; 'codex.open': ...; 'codex.attach': ...; 'codex.status': ...; 'server.shutdown': ...
}
export type FsEntry = { name: string; kind: 'dir' | 'file' | 'symlink' }
// codex.open 的 initialize 字段类型用 unknown（避免协议包依赖 vendor）

// Node 流适配（单独文件 src/node.ts，从 '@qn/protocol/node' 不可用，所以也在 index 导出，但只用 type import Node 类型）
export function attachFramedStream(
  stream: { write(b: Uint8Array): boolean; on(ev: 'data', cb: (b: Uint8Array) => void): unknown; on(ev: 'close' | 'end', cb: () => void): unknown; on(ev: 'error', cb: (e: Error) => void): unknown; destroy(): void },
  handlers: { onMessage(msg: unknown): void; onClose(err?: Error): void },
): { send(msg: unknown): void; close(): void }   // 解码错误时 destroy 并 onClose(err)；onClose 只调用一次
```

测试（`src/*.test.ts`）：编解码往返、逐字节切分、多帧粘包、超限、非法 JSON、中文内容、parse*Message 正反例、classifyJsonRpc 各情形、attachFramedStream 用 `node:stream` 的 PassThrough/Duplex 对接测试。
