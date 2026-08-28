import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildQingcodeCliSkillMarkdown,
  isChineseSkillLanguage,
  QINGCODE_CLI_REPO_BINARY,
} from './qingcodeCliSkill'

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
    expect(md).toContain('Windows access to SSH/WSL services')
    expect(md).toContain('127.0.0.1')
  })

  it('quotes paths with spaces', () => {
    const md = buildQingcodeCliSkillMarkdown('C:\\Program Files\\QingCode.exe')
    expect(md).toContain('"C:\\Program Files\\QingCode.exe" project list')
  })

  it('copies Chinese only for Chinese locales and English for every other locale', () => {
    expect(isChineseSkillLanguage('zh-CN')).toBe(true)
    expect(isChineseSkillLanguage('zh-TW')).toBe(true)
    expect(isChineseSkillLanguage('en')).toBe(false)
    expect(isChineseSkillLanguage('ja-JP')).toBe(false)

    expect(buildQingcodeCliSkillMarkdown('QingCode.exe', 'zh-CN')).toContain(
      '# QingCode CLI\n\n将此文件作为 Skill'
    )
    expect(buildQingcodeCliSkillMarkdown('QingCode.exe', 'zh-CN')).toContain(
      'Windows 访问 SSH/WSL 服务'
    )
    expect(buildQingcodeCliSkillMarkdown('QingCode.exe', 'en')).toContain(
      'Install this file into your AI agent'
    )
    expect(buildQingcodeCliSkillMarkdown('QingCode.exe', 'fr-FR')).toContain(
      'Install this file into your AI agent'
    )
  })

  it('keeps the repository Skill snapshot in sync with the canonical template', () => {
    const skillPath = fileURLToPath(
      new URL('../../.agents/skills/qingcode-cli/SKILL.md', import.meta.url)
    )
    const snapshot = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n')

    expect(snapshot).toBe(buildQingcodeCliSkillMarkdown(QINGCODE_CLI_REPO_BINARY, 'en'))
  })
})
