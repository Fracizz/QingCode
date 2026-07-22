import { describe, expect, it } from 'vitest'
import { buildQingcodeCliSkillMarkdown } from './qingcodeCliSkill'

describe('buildQingcodeCliSkillMarkdown', () => {
  it('embeds exe path and core commands', () => {
    const md = buildQingcodeCliSkillMarkdown('D:\\Apps\\QingCode.exe')
    expect(md).toContain('name: qingcode-cli')
    expect(md).toContain('D:\\Apps\\QingCode.exe project list')
    expect(md).toContain('run start')
    expect(md).toContain('does not')
    expect(md).toContain('auto-register')
  })

  it('quotes paths with spaces', () => {
    const md = buildQingcodeCliSkillMarkdown('C:\\Program Files\\QingCode.exe')
    expect(md).toContain('"C:\\Program Files\\QingCode.exe" project list')
  })
})
