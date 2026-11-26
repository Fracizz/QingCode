import { describe, expect, it, vi } from 'vitest'
import { defaultCommands } from './defaultCommands'

describe('defaultCommands', () => {
  it('未提供的动作不生成命令', () => {
    expect(defaultCommands({})).toEqual([])
    expect(defaultCommands({ toggleSidebar: () => {} }).map((c) => c.id)).toEqual(['view.sidebar.toggle'])
  })

  it('停靠栏工具命令调用 toggleDockTool 并带快捷键', () => {
    const toggleDockTool = vi.fn()
    const commands = defaultCommands({ toggleDockTool })
    expect(commands.map((c) => c.shortcut)).toEqual(['Ctrl+Shift+E', 'Ctrl+Shift+F', 'Ctrl+Shift+G'])
    for (const command of commands) void command.run()
    expect(toggleDockTool.mock.calls.map((call) => call[0])).toEqual(['explorer', 'search', 'git'])
  })

  it('设置命令：总入口 + 每个分区', () => {
    const openSettings = vi.fn<(section?: 'general' | 'about') => void>()
    const commands = defaultCommands({
      openSettings,
      settingsSections: [
        { id: 'general', label: '通用' },
        { id: 'about', label: '关于' },
      ],
    })
    expect(commands.map((c) => c.id)).toEqual(['settings.open', 'settings.open.general', 'settings.open.about'])
    void commands[0]!.run()
    void commands[2]!.run()
    expect(openSettings).toHaveBeenNthCalledWith(1)
    expect(openSettings).toHaveBeenNthCalledWith(2, 'about')
  })

  it('when 条件透传', () => {
    let ready = false
    const [quick] = defaultCommands({ quickOpen: () => {}, canQuickOpen: () => ready })
    expect(quick!.when?.()).toBe(false)
    ready = true
    expect(quick!.when?.()).toBe(true)
    const [plain] = defaultCommands({ quickOpen: () => {} })
    expect(plain!.when).toBeUndefined()
  })

  it('id 唯一', () => {
    const noop = () => {}
    const commands = defaultCommands({
      toggleDockTool: noop,
      hideDockTool: noop,
      openSettings: noop,
      settingsSections: [{ id: 'general', label: '通用' }],
      quickOpen: noop,
      newThread: noop,
      interrupt: noop,
      toggleSidebar: noop,
      addProject: noop,
      addTarget: noop,
      importLegacy: noop,
      openMobile: noop,
      reloadWindow: noop,
    })
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
    expect(commands.length).toBe(15)
  })
})
