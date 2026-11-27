import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCK, FILES_MAX, TOOL_MIN, parseDockPrefs, useDock } from './dock'

describe('停靠栏偏好解析', () => {
  it('缺失或损坏时回落默认', () => {
    expect(parseDockPrefs(null)).toEqual(DEFAULT_DOCK)
    expect(parseDockPrefs('{bad')).toEqual(DEFAULT_DOCK)
  })

  it('宽度夹紧到范围内，未知工具视为收起', () => {
    expect(parseDockPrefs(JSON.stringify({ tool: 'git', filesWidth: 99999, toolWidth: 10 }))).toEqual({
      tool: 'git',
      filesWidth: FILES_MAX,
      toolWidth: TOOL_MIN,
    })
    expect(parseDockPrefs(JSON.stringify({ tool: 'terminal' })).tool).toBeNull()
  })
})

it('文件视图的目录和内容搜索独立于聊天停靠栏', () => {
  const dock = useDock.getState()
  dock.showTool('git')
  dock.setView('files')
  dock.toggleTool('search')
  expect(useDock.getState()).toMatchObject({ view: 'files', fileTool: 'search', tool: 'git' })
  dock.toggleTool('explorer')
  dock.setView('chat')
  expect(useDock.getState()).toMatchObject({ view: 'chat', fileTool: 'explorer', tool: 'git' })
})
