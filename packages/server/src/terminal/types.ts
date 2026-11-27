// protocol 的 index.ts 不在 T29 范围内，term.* 类型暂从源文件做纯类型导入（构建时擦除）；
// 总管在 @qn/protocol 的 index 导出这些类型后，把这里改成从 '@qn/protocol' 导入即可。
export type {
  TermAttachResult,
  TermBackend,
  TermBackendPreference,
  TermDataEvt,
  TermErrorCode,
  TermErrorEvt,
  TermExitEvt,
  TermExitInfo,
  TermInfo,
  TermOpenResult,
  TermResizedEvt,
  TermSnapshot,
} from '@qn/protocol/src/workspace'
