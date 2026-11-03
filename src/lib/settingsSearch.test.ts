import { describe, expect, it } from 'vitest'
import { matchesSettingsCategory, matchesSettingsTerms } from './settingsSearch'
const t = (key: string) => ({ 小地图: 'Minimap', 文本编辑器: 'Text editor', 参考线: 'Guides' })[key] ?? key

describe('settings search aliases and scope', () => {
  it('finds a configuration key through the same row and navigation aliases', () => {
    expect(matchesSettingsCategory('editor', 'editor.minimap.enabled', false, t)).toBe(true)
    expect(matchesSettingsTerms('editor.minimap.enabled', ['小地图', 'minimap'], false, t)).toBe(true)
    expect(matchesSettingsTerms('editor.minimap.enabled', ['自动保存'], false, t)).toBe(false)
    expect(matchesSettingsCategory('editor', 'guides', false, t)).toBe(true)
  })
  it('matches translated category names and exposes their rows', () => {
    expect(matchesSettingsCategory('editor', 'text editor', false, t)).toBe(true)
    expect(matchesSettingsTerms('text editor', ['参考线'], false, t)).toBe(true)
  })
  it('does not advertise user-only categories or features in project settings', () => {
    expect(matchesSettingsCategory('ai', '', true, t)).toBe(false)
    expect(matchesSettingsCategory('about', '', true, t)).toBe(false)
    expect(matchesSettingsCategory('features', 'qingcode.session.persist', true, t)).toBe(false)
    expect(matchesSettingsCategory('features', 'ssh.server.offlineDir'.toLowerCase(), true, t)).toBe(true)
  })
})
