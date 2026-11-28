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
  ThreadUnreadEntry,
  ThreadUnreadEvent,
} from './messages'

export { AGENT_CAPABILITIES, agentResumeCommand, PROMPT_SUGGESTION_METHOD } from './agents'
export type { AgentCapabilities } from './agents'

export { attachFramedStream } from './node'
export type { FramedStream, FramedHandlers, FramedConnection } from './node'

export type {
  WorkspaceErrorCode,
  FsKind,
  FsStat,
  FsReadParams,
  FsReadResult,
  FsWriteParams,
  FsSearchMode,
  FsSearchParams,
  FsSearchMatch,
  FsSearchResultEvt,
  FsChangedEvt,
  ProjectFileEntry,
  ProjectFileList,
  ProjectFileChunk,
  GitFileStatus,
  GitStatusResult,
  GitBranch,
  GitRemoteAddress,
  GitCommit,
  WorkspaceMethods,
  WorkspaceMethod,
  TermErrorCode,
  TermBackend,
  TermBackendPreference,
  TermOpenParams,
  TermExitInfo,
  TermInfo,
  TermOpenResult,
  TermOutputChunk,
  TermSnapshot,
  TermAttachParams,
  TermAttachResult,
  TermDataEvt,
  TermExitEvt,
  TermResizedEvt,
  TermErrorEvt,
} from './workspace'

export {
  DIRECT_CODE_PREFIX,
  encodeDirectCode,
  decodeDirectCode,
  normalizeFingerprint,
  isValidFingerprint,
} from './direct'
export type { DirectInfo } from './direct'

export { t, translateMessage, addEnglishMessages, setLocale, getLocale, resolveLocale } from './i18n'
export type { Locale, LocalePreference, MessageParams } from './i18n'

export type {
  ScheduleCadence, ScheduleChangedEvent, ScheduleFrequency, ScheduleInput, ScheduleMethods,
  ScheduleRun, ScheduleRunReason, ScheduleRunStatus, ScheduleRuntime, ScheduleSummary,
} from './schedule'
