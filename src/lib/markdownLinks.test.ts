import { describe, expect, it } from 'vitest'
import { resolveMarkdownLink } from './markdownLinks'

describe('resolveMarkdownLink', () => {
  const remote = 'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/CLAUDE.md'

  it('resolves project-relative links against the SSH document directory', () => {
    expect(resolveMarkdownLink(remote, 'docs/internal/technical/internal-test-accounts.md')).toEqual({
      kind: 'file',
      path: 'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/docs/internal/technical/internal-test-accounts.md',
    })
  })

  it('resolves root-relative links from the project root', () => {
    expect(resolveMarkdownLink(
      remote,
      '/docs/internal/technical/internal-test-accounts.md',
      'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel',
    )).toEqual({
      kind: 'file',
      path: 'ssh://68871d56-516a-4b40-b83d-d1f8342b9f4c/home/code/nem-panel/docs/internal/technical/internal-test-accounts.md',
    })
  })

  it('resolves parent paths, URL encoding and line fragments for local files', () => {
    expect(resolveMarkdownLink('D:\\repo\\docs\\README.md', '../src/my%20file.ts#L21')).toEqual({
      kind: 'file',
      path: 'D:/repo/src/my file.ts',
      line: 21,
    })
  })

  it('keeps external URLs external and rejects script links', () => {
    expect(resolveMarkdownLink(remote, 'https://example.com/docs')).toEqual({
      kind: 'external', url: 'https://example.com/docs',
    })
    expect(resolveMarkdownLink(remote, 'javascript:alert(1)')).toEqual({ kind: 'unsupported' })
    expect(resolveMarkdownLink(remote, 'ssh://other/home/code/file.md')).toEqual({ kind: 'unsupported' })
  })
})
