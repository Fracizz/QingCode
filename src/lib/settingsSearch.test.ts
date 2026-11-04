import { describe, expect, it } from 'vitest'
import { matchesSettingsCategory, matchesSettingsTerms } from './settingsSearch'
const t = (key: string) => ({ 小地图: 'Minimap', '编辑器与文件': 'Editor and files', 文本编辑器: 'Text editor', 参考线: 'Guides' })[key] ?? key

describe('settings search aliases and scope', () => {
  it('finds a configuration key through the same row and navigation aliases', () => {
    expect(matchesSettingsCategory('editor', 'editor.minimap.enabled', false, t)).toBe(true)
    expect(matchesSettingsTerms('editor.minimap.enabled', ['小地图', 'minimap'], false, t)).toBe(true)
    expect(matchesSettingsTerms('editor.minimap.enabled', ['自动保存'], false, t)).toBe(false)
    expect(matchesSettingsCategory('editor', 'guides', false, t)).toBe(true)
    for (const query of ['android', '安卓', '移动连接', '二维码', '配对', '密码', 'tailscale']) {
      expect(matchesSettingsCategory('mobile', query, false, t)).toBe(true)
      expect(matchesSettingsCategory('remote', query, false, t)).toBe(false)
    }
  })
  it('matches translated category names and exposes their rows', () => {
    expect(matchesSettingsCategory('editor', 'text editor', false, t)).toBe(true)
    expect(matchesSettingsTerms('text editor', ['参考线'], false, t)).toBe(true)
    expect(matchesSettingsCategory('editor', 'editor and files', false, t)).toBe(true)
    expect(matchesSettingsTerms('editor and files', ['参考线'], false, t)).toBe(true)
  })
  it('does not advertise user-only categories or features in project settings', () => {
    expect(matchesSettingsCategory('tools', '', true, t)).toBe(false)
    for (const category of ['appearance', 'projects', 'shortcuts'] as const) {
      expect(matchesSettingsCategory(category, '', true, t)).toBe(false)
    }
    expect(matchesSettingsCategory('about', '', true, t)).toBe(false)
    expect(matchesSettingsCategory('mobile', '', true, t)).toBe(false)
    expect(matchesSettingsCategory('projects', 'qingcode.session.persist', true, t)).toBe(false)
    expect(matchesSettingsCategory('remote', 'ssh.server.offlineDir'.toLowerCase(), true, t)).toBe(true)
  })
  it('finds full visible setting titles with the same row aliases', () => {
    for (const [category, title, alias] of [
      ['editor', '编辑器: 小地图', '小地图'],
      ['terminal', '终端 › 集成: 字号', '终端字号'],
      ['remote', 'SSH › 服务: 离线目录', '离线目录'],
      ['about', '启动时自动检查更新', '检查更新'],
      ['tools', 'Windows 打开方式', '打开方式'],
    ] as const) {
      expect(matchesSettingsCategory(category, title.toLowerCase(), false, t)).toBe(true)
      expect(matchesSettingsTerms(title.toLowerCase(), [alias], false, t)).toBe(true)
    }
  })

  it('hides platform-only results outside Windows', () => {
    expect(matchesSettingsCategory('mobile', '', false, t, false)).toBe(false)
    expect(matchesSettingsCategory('tools', 'windows', false, t, false)).toBe(false)
    expect(matchesSettingsCategory('tools', 'skills', false, t, false)).toBe(true)
  })
})
