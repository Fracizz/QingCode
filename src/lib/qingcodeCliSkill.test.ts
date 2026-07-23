import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildQingcodeCliSkillMarkdown, QINGCODE_CLI_REPO_BINARY } from './qingcodeCliSkill'

describe('buildQingcodeCliSkillMarkdown', () => {
  it('embeds exe path and core commands', () => {
    const md = buildQingcodeCliSkillMarkdown('D:\\Apps\\QingCode.exe')
    expect(md).toContain('name: qingcode-cli')
    expect(md).toContain('D:\\Apps\\QingCode.exe project list')
    expect(md).toContain('run start')
    expect(md).toContain('does not')
    expect(md).toContain('auto-register')
    expect(md).toContain('It is not a partial patch')
    expect(md).toContain('Never grant trust implicitly')
  })

  it('quotes paths with spaces', () => {
    const md = buildQingcodeCliSkillMarkdown('C:\\Program Files\\QingCode.exe')
    expect(md).toContain('"C:\\Program Files\\QingCode.exe" project list')
  })

  it('keeps the repository Skill snapshot in sync with the canonical template', () => {
    const skillPath = fileURLToPath(
      new URL('../../.agents/skills/qingcode-cli/SKILL.md', import.meta.url)
    )
    const snapshot = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n')

    expect(snapshot).toBe(buildQingcodeCliSkillMarkdown(QINGCODE_CLI_REPO_BINARY))
  })
})
