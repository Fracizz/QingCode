import type {
  GitBranchList,
  GitCommitFileChange,
  GitCommitInfo,
  GitFileContents,
  GitPullResult,
  GitRemote,
  GitStatus,
} from '../git/git'
import type { GitWorkdirStatus } from '../git/gitStatus'
import { safeInvoke } from '../tauri'

export type GitHeadInfo = {
  name: string
  detached: boolean
}

export function getGitHead(path: string): Promise<GitHeadInfo | null> {
  return safeInvoke('读取 Git 分支', 'get_git_head', { path })
}

export function getGitWorkdirStatus(path: string): Promise<GitWorkdirStatus | null> {
  return safeInvoke('读取 Git 状态', 'get_git_workdir_status', { path })
}

export function getGitStatus(path: string): Promise<GitStatus> {
  return safeInvoke('读取 Git 状态', 'git_status', { path })
}

export function getGitLog(path: string, limit: number, skip: number): Promise<GitCommitInfo[]> {
  return safeInvoke('读取提交记录', 'git_log', { path, limit, skip })
}

export function getGitBranches(path: string): Promise<GitBranchList> {
  return safeInvoke('读取分支列表', 'git_branch_list', { path })
}

export function getGitRemotes(path: string): Promise<GitRemote[]> {
  return safeInvoke('读取远程地址', 'git_remotes', { path })
}

export function switchGitBranch(path: string, branch: string): Promise<void> {
  return safeInvoke('切换 Git 分支', 'git_switch', { path, branch })
}

export function getGitCommitFiles(path: string, rev: string): Promise<GitCommitFileChange[]> {
  return safeInvoke('读取提交文件', 'git_commit_files', { path, rev })
}

export function getGitCommitFileContents(
  path: string,
  rev: string,
  file: string
): Promise<GitFileContents> {
  return safeInvoke('读取提交文件内容', 'git_commit_file_contents', { path, rev, file })
}

export function changeGitStage(
  path: string,
  files: string[],
  mode: 'stage' | 'unstage',
  all = false
): Promise<void> {
  return safeInvoke(
    mode === 'stage' ? '暂存 Git 更改' : '取消暂存 Git 更改',
    mode === 'stage' ? 'git_stage' : 'git_unstage',
    { path, files: all ? [] : files, all: all || null }
  )
}

export function discardGitChanges(path: string, files: string[], staged: boolean): Promise<void> {
  return safeInvoke('丢弃 Git 更改', 'git_discard', { path, files, staged })
}

export function pullGit(path: string, rebase = false): Promise<GitPullResult> {
  return safeInvoke('拉取 Git 更改', 'git_pull', { path, rebase })
}

export function commitGit(path: string, message: string): Promise<string> {
  return safeInvoke('提交 Git 更改', 'git_commit', { path, message })
}

export function pushGit(path: string): Promise<string> {
  return safeInvoke('推送 Git 提交', 'git_push', { path })
}

export function fetchGit(path: string): Promise<string> {
  return safeInvoke('获取远程更新', 'git_fetch', { path })
}

export function getGitFileContents(path: string, file: string): Promise<GitFileContents> {
  return safeInvoke('读取 Git 文件内容', 'git_file_contents', { path, file })
}

export function showGitHeadFile(path: string): Promise<string | null> {
  return safeInvoke('读取 Git HEAD 文件', 'git_show_head_file', { path })
}
