// 差异视图的两侧内容：worktree 用 git.show(HEAD) + 当前文件；staged/commit 用 git.show + 统一 diff 还原新版本。

import { t } from '@qn/codex-client'
import { serverCall } from '../workspace/serverCall'
import { applyUnifiedDiff } from './diffModel'
import { toEditorText } from './editModel'
import type { DiffMode } from './filesModel'
import { errorMessage } from './filesModel'

export type DiffSideRequest = {
  targetId: string
  path: string
  cwd: string
  mode: DiffMode
  commit?: string
  /** 已由 store 取到的 git.diff 文本 */
  diff: string
  diffTruncated?: boolean
}

export type DiffSides = {
  original: string
  modified: string
  oldLabel: string
  newLabel: string
  notice?: string
}

/** 二进制、旧 server 不支持 git.show 等情况退回统一 diff 文本渲染。 */
export class DiffSidesError extends Error {
  constructor(message: string, readonly code = 'binary') {
    super(message)
    this.name = 'DiffSidesError'
  }
}

function shortCommit(commit?: string): string {
  return commit ? commit.slice(0, 7) : t('提交')
}

/** 旧版本 ref：commit 模式取父提交（根提交不存在时 server 返回 exists:false，按空文件处理）。 */
export function oldRefOf(mode: DiffMode, commit?: string): string | undefined {
  return mode === 'commit' && commit ? `${commit}^` : undefined
}

export async function loadDiffSides(req: DiffSideRequest): Promise<DiffSides> {
  const ref = oldRefOf(req.mode, req.commit)
  const showParams: { cwd: string; path: string; ref?: string } = { cwd: req.cwd, path: req.path }
  if (ref) showParams.ref = ref

  let old: { content: string; binary: boolean; exists: boolean }
  try {
    old = await serverCall(req.targetId, 'git.show', showParams)
  } catch (err) {
    throw new DiffSidesError(errorMessage(err, t('读取旧版本失败')), 'git_show')
  }
  if (old.binary) throw new DiffSidesError(t('旧版本是二进制文件，按 diff 文本显示'))
  const original = toEditorText(old.content)

  const oldLabel = req.mode === 'commit' ? t('上一版本') : 'HEAD'
  const newLabel =
    req.mode === 'staged' ? t('暂存区') : req.mode === 'commit' ? t('提交 {hash}', { hash: shortCommit(req.commit) }) : t('当前文件')

  if (req.mode === 'worktree') {
    let current
    try {
      current = await serverCall(req.targetId, 'fs.read', { path: req.path })
    } catch (err) {
      throw new DiffSidesError(errorMessage(err, t('读取当前文件失败')), 'fs_read')
    }
    if (current.binary) throw new DiffSidesError(t('当前文件是二进制文件，按 diff 文本显示'))
    return {
      original,
      modified: toEditorText(current.content),
      oldLabel,
      newLabel,
      notice: current.truncated ? t('当前文件较大，右侧仅显示前 2 MiB') : undefined,
    }
  }

  const patched = applyUnifiedDiff(original, req.diff)
  const notices: string[] = []
  if (req.diffTruncated) notices.push(t('diff 内容已截断，右侧可能不完整'))
  if (!patched.applied) notices.push(t('diff 与旧版本不完全匹配，右侧可能不准确'))
  return {
    original,
    modified: patched.text,
    oldLabel,
    newLabel,
    notice: notices.length ? notices.join(' · ') : undefined,
  }
}
