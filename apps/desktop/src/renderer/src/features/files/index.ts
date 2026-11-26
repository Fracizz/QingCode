// T18 集成点：接入布局、Markdown 链接、文件改动卡片只用这里导出的符号。

export { FilePane } from './FilePane'
export { useFiles, getFileWatchPaths } from './filesStore'
export { createMarkdownLink, qnUrlTransform, PathText, FileChangeActions } from './integrations'
export type { LinkContext } from './integrations'

// 纯逻辑与类型：总管按需复用。
export { parseFileHref, findPathsInText, fileKind, imageMime, imageDataUrl, langForPath, basename, dirname, extname, joinPath, normalizePath, isAbsolutePath } from './fileLinks'
export type { FileLocation, PathMatch, FileKind, PathStyle } from './fileLinks'
export { errorMessage, errorCodeOf, diffModeLabel, tabKeyOf } from './filesModel'
export type { Tab, TabStatus, TabView, DiffMode } from './filesModel'
export { parseUnifiedDiff, diffStat } from './diffModel'
