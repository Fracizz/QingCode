import { describe, expect, it } from 'vitest'
import {
  extractGitOverwrittenFiles,
  formatGitChangedFileList,
  gitPullErrorI18n,
  gitSwitchErrorI18n,
  normalizeGitPullErrorRaw,
  parseScmErrorDisplay,
} from './gitErrorMessage'

describe('gitPullErrorI18n', () => {
  it('parses local changes overwrite noise into a concise message', () => {
    const raw = `拉取失败：Git 拉取失败：https://github.com/Fracizz/QingCode
6996f46..d176b3a feat/heuristic-definition-navigation -> origin/feat/heuristic-definition-navigation
error: Your local changes to the following files would be overwritten by merge:
\tsrc/App.tsx
Please commit your changes or stash them before you merge.
Aborting
Updating 6996f46..d176b3a`

    const i18n = gitPullErrorI18n(raw)
    expect(i18n.key).toBe('拉取失败：本地修改「{file}」尚未提交，请先提交或暂存后再拉取')
    expect(i18n.params).toEqual({ file: 'src/App.tsx' })
  })

  it('summarizes multiple overwritten files', () => {
    const files = extractGitOverwrittenFiles(`error: Your local changes to the following files would be overwritten by merge:
\ta.ts
\tb.ts
\tc.ts
Please commit your changes or stash them before you merge.`)
    expect(formatGitChangedFileList(files)).toBe('a.ts、b.ts、c.ts')
    expect(gitPullErrorI18n('local changes would be overwritten by merge:\na.ts\nb.ts\nPlease commit').key).toBe(
      '拉取失败：本地有未提交修改（{files}），请先提交或暂存后再拉取',
    )
  })

  it('strips fetch progress lines from normalized raw text', () => {
    const normalized = normalizeGitPullErrorRaw(`Git 拉取失败：https://github.com/x/y
abcd123..ef01234 main -> origin/main
error: failed to connect`)
    expect(normalized).not.toMatch(/https:\/\//)
    expect(normalized).toContain('failed to connect')
  })

  it('parses checkout overwrite errors for branch switch', () => {
    const raw = `切换 Git 分支失败：error: Your local changes to the following files would be overwritten by checkout:
\tsrc/components/ScmToolbar.tsx
\tsrc/components/SourceControlPanel.tsx
Please commit your changes or stash them before you switch branches.
Aborting`

    const i18n = gitSwitchErrorI18n(raw)
    expect(i18n.key).toBe('切换分支失败：本地有未提交修改（{files}），请先提交或暂存后再切换')
    expect(i18n.params?.files).toBe('src/components/ScmToolbar.tsx、src/components/SourceControlPanel.tsx')

    const display = parseScmErrorDisplay(raw)
    expect(display.files).toEqual([
      'src/components/ScmToolbar.tsx',
      'src/components/SourceControlPanel.tsx',
    ])
  })
})
