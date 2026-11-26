# T2 Codex 客户端 packages/codex-client

范围：只改 `packages/codex-client/src/**`。可读 `vendor/codex-protocol/ts/**`（codex 0.172.0 生成的类型，只读，用 `import type` 相对路径引用）与 `vendor/codex-protocol/schema/**`。

背景：`docs/mvp.md` §3.3、§6。渲染进程通过一个抽象传输与 codex app-server 对话（中间经 backend 和 server 中继，`initialize` 已由 server 完成，客户端**不要**发 initialize）。

## 1. RPC 客户端 `src/rpc.ts`

```ts
export interface CodexTransport {
  send(msg: unknown): void                                   // 原始 JSON-RPC
  onMessage(cb: (msg: unknown, seq: number | null) => void): () => void
}
export class CodexRpc {
  constructor(t: CodexTransport, opts?: { timeoutMs?: number })   // 默认 0 = 不超时
  request<M extends keyof ClientRequestMap>(method: M, params: ClientRequestMap[M]['params']): Promise<ClientRequestMap[M]['result']>
  onNotification(cb: (n: ServerNotification) => void): () => void
  onServerRequest(cb: (r: ServerRequest) => void): () => void
  respond(id: RequestId, result: unknown): void
  respondError(id: RequestId, code: number, message: string): void
  dispose(): void                                            // 所有未决请求 reject
}
```
- 客户端请求 id 用字符串 `c<递增>`，避免与 server 侧冲突。
- `ClientRequestMap`：至少覆盖 `thread/list`、`thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/interrupt`、`model/list`、`account/read`，params/result 用 vendor `v2/*Params`、`v2/*Response` 类型。

## 2. 对话状态 `src/conversation.ts`（纯函数 + 单测，重点）

```ts
export type ConversationState = { threads: Record<string, ThreadView> }
export type ThreadView = {
  id: string; status: 'idle' | 'running' | 'error'; activeTurnId: string | null
  items: ItemView[]                 // 按出现顺序
  pendingApprovals: ApprovalView[]  // 来自 server request，收到 serverRequest/resolved 或本地响应后移除
  error?: string; tokenUsage?: unknown
}
export type ItemView =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; summary: string; streaming: boolean }
  | { kind: 'command'; id: string; command: string; cwd?: string; output: string; exitCode?: number | null; status: string }
  | { kind: 'fileChange'; id: string; changes: { path: string; kind: string; diff?: string }[]; status: string }
  | { kind: 'other'; id: string; type: string; summary: string }
export type ApprovalView = { requestId: RequestId; threadId: string; itemId?: string; kind: 'command' | 'fileChange' | 'permissions' | 'other'; title: string; detail: string; method: string; raw: unknown }

export function emptyState(): ConversationState
export function loadThread(s, thread: Thread /* thread/read 或 thread/resume 返回的完整 thread，含 turns/items */): ConversationState
export function applyNotification(s, n: ServerNotification): ConversationState   // 不可变更新
export function applyServerRequest(s, r: ServerRequest): ConversationState
export function resolveServerRequest(s, requestId): ConversationState
export function approvalResponse(a: ApprovalView, decision: 'accept' | 'acceptForSession' | 'decline'): unknown  // 生成对应 method 的响应体
```
- 至少处理：`thread/started`、`thread/status/changed`、`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`serverRequest/resolved`、`thread/tokenUsage/updated`、`error`。未知通知原样忽略。
- 审批：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`（以及旧版 `execCommandApproval`/`applyPatchApproval`）。响应体字段以 vendor 类型为准（如 `v2/CommandExecutionRequestApprovalResponse`），先查清楚再写。
- 字段名一律以 vendor 生成类型为准，仔细读 `v2/ThreadItem.ts`、`v2/Turn.ts`、`v2/Thread.ts` 及各 Notification 类型。

## 3. 便捷函数 `src/api.ts`

`listThreads(rpc, cwd)`、`startThread(rpc, { cwd })`、`resumeThread(rpc, threadId)`、`sendText(rpc, threadId, text)`、`interruptTurn(rpc, threadId, turnId)`。

## 测试

用手写的通知序列（贴近真实字段）覆盖：一次完整 turn（用户消息→推理→命令执行带输出→文件改动→agent 流式消息→turn 完成）、审批出现与解决、中断、错误、loadThread 后继续接收增量、未知通知不崩。
