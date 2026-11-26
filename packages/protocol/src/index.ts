export { PROTOCOL_VERSION, MAX_FRAME_BYTES } from './constants'
export { FrameError, encodeFrame, FrameDecoder } from './frame'

export { classifyJsonRpc, isJsonRpcRequest, isJsonRpcNotification, isJsonRpcResponse } from './jsonrpc'
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcMessage,
  JsonRpcKind,
} from './jsonrpc'

export { parseClientMessage, parseServerMessage, parseAgent, isAgentKind } from './messages'
export type {
  AgentKind,
  ClientInfo,
  WireError,
  Hello,
  Welcome,
  Req,
  ResOk,
  ResErr,
  Res,
  Evt,
  CodexSend,
  CodexRecv,
  ErrorMsg,
  ClientMessage,
  ServerMessage,
  WireMessage,
  FsEntry,
  ServerMethods,
  ServerMethod,
  ServerParams,
  ServerResult,
} from './messages'

export { attachFramedStream } from './node'
export type { FramedStream, FramedHandlers, FramedConnection } from './node'
