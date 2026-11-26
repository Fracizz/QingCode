import { describe, expect, it } from 'vitest'
import { configuredAgentOpen } from './openConfig'

describe('Agent 启动参数', () => {
  it('按 Agent 分别传配置目录与可执行文件路径', () => {
    expect(configuredAgentOpen('codex', { configDir: ' /tmp/project-cfg ' })).toEqual({
      agent: 'codex', codexHome: '/tmp/project-cfg',
    })
    expect(configuredAgentOpen('claude', { path: ' C:\\claude.exe ', configDir: ' D:\\profile ' })).toEqual({
      agent: 'claude', claudePath: 'C:\\claude.exe', claudeConfigDir: 'D:\\profile',
    })
    expect(configuredAgentOpen('pi', { path: '/tmp/pi', configDir: '/ignored' })).toEqual({ agent: 'pi', piPath: '/tmp/pi' })
    expect(configuredAgentOpen('codex', { path: '', configDir: '   ' })).toEqual({ agent: 'codex' })
  })
})
