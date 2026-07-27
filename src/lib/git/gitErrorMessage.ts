export type GitPullErrorI18n = {
  key: string
  params?: Record<string, string | number>
}

/** Strip repeated UI / Rust prefixes and fetch progress noise. */
export function normalizeGitPullErrorRaw(raw: string): string {
  let text = raw.trim()
  for (let i = 0; i < 3; i++) {
    const next = text
      .replace(/^(?:拉取失败[：:]\s*)+/u, '')
      .replace(/^(?:Git 拉取失败[：:]\s*)+/u, '')
      .replace(/^(?:Git pull failed[：:]\s*)+/iu, '')
      .trim()
    if (next === text) break
    text = next
  }
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (/^https?:\/\//i.test(trimmed)) return false
      if (/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i.test(trimmed)) return false
      if (/^Updating [0-9a-f]{7,40}/i.test(trimmed)) return false
      if (/^From https?:\/\//i.test(trimmed)) return false
      if (/^remote:\s/i.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

/** Extract paths from git "local changes would be overwritten" errors. */
export function extractGitOverwrittenFiles(text: string): string[] {
  const block =
    /local changes to the following files would be overwritten by merge:\s*([\s\S]*?)(?:\nPlease commit|\nAborting|$)/i.exec(
      text,
    )?.[1] ??
    /您对下列文件的本地更改将被合并操作覆盖：\s*([\s\S]*?)(?:\n请提交|\nAborting|$)/u.exec(text)?.[1]
  if (!block) return []
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

export function formatGitChangedFileList(files: string[], maxShown = 3): string {
  if (files.length === 0) return ''
  if (files.length === 1) return files[0]
  const head = files.slice(0, maxShown).join('、')
  if (files.length <= maxShown) return head
  return `${head} 等 ${files.length} 个文件`
}

function lastMeaningfulGitLine(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const errLine = [...lines]
    .reverse()
    .find(line => /^error:/i.test(line) || /失败/u.test(line) || /fatal:/i.test(line))
  const candidate = errLine ?? lines[lines.length - 1] ?? text
  return candidate.replace(/^(?:error|fatal):\s*/i, '').trim()
}

/** Map raw git pull failure text to a concise i18n key + params. */
export function gitPullErrorI18n(raw: string): GitPullErrorI18n {
  const text = normalizeGitPullErrorRaw(raw)
  const lower = text.toLowerCase()

  const overwritten = extractGitOverwrittenFiles(text)
  if (
    overwritten.length > 0 ||
    lower.includes('would be overwritten by merge') ||
    text.includes('本地更改将被合并操作覆盖')
  ) {
    if (overwritten.length === 1) {
      return {
        key: '拉取失败：本地修改「{file}」尚未提交，请先提交或暂存后再拉取',
        params: { file: overwritten[0] },
      }
    }
    const files = formatGitChangedFileList(overwritten)
    return {
      key: '拉取失败：本地有未提交修改（{files}），请先提交或暂存后再拉取',
      params: { files: files || '…' },
    }
  }

  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('permission denied') ||
    text.includes('认证失败') ||
    text.includes('权限被拒绝')
  ) {
    return { key: '拉取失败：远程认证失败，请检查凭据或 SSH 密钥' }
  }

  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('failed to connect') ||
    lower.includes('unable to access') ||
    text.includes('无法连接')
  ) {
    return { key: '拉取失败：无法连接远程仓库，请检查网络或远程地址' }
  }

  const detail = lastMeaningfulGitLine(text)
  if (!detail) {
    return { key: '拉取失败：操作已取消' }
  }
  const clipped = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail
  return { key: '拉取失败：{detail}', params: { detail: clipped } }
}
