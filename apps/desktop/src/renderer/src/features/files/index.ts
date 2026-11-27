// T18/T25 集成点：接入布局、Markdown 链接、文件改动卡片只用这里导出的符号。

export { FilePane } from './FilePane'
export { useFiles, getFileWatchPaths, subscribeFileWatch } from './filesStore'
export { createMarkdownLink, qnUrlTransform, PathText, FileChangeActions } from './integrations'
export type { LinkContext } from './integrations'

// 纯逻辑与类型：总管按需复用。
export { parseFileHref, findPathsInText, fileKind, imageMime, imageDataUrl, langForPath, basename, dirname, extname, joinPath, normalizePath, isAbsolutePath } from './fileLinks'
export type { FileLocation, PathMatch, FileKind, PathStyle } from './fileLinks'
export { errorMessage, errorCodeOf, diffModeLabel, tabKeyOf, watchKey, watchPaths, pathWatchKey, loadedLabel } from './filesModel'
export type { Tab, TabStatus, TabView, DiffMode } from './filesModel'
export { parseUnifiedDiff, diffStat, applyUnifiedDiff } from './diffModel'
export {
  detectEol,
  toEditorText,
  toDiskText,
  isDirty,
  readOnlyReason,
  readOnlyLabel,
  applyLocalEdit,
  markSaved,
  markDiskChanged,
  applyDiskText,
  planConflict,
} from './editModel'
export type { Eol, ReadOnlyReason, ConflictAction, ConflictPlan, FilePrompt } from './editModel'
export { matchFileName, matchLanguageDescription, loadLanguageForPath } from './editor/languages'
