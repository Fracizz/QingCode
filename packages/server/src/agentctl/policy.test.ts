import { describe, expect, it } from 'vitest'
import { AGENT_REQ_METHODS } from './policy'

describe('qn 权限边界', () => {
  it('不含执行命令、写文件、Agent 协议与管理类方法', () => {
    for (const method of ['run.start', 'run.stop', 'term.open', 'term.write', 'fs.write', 'fs.delete', 'git.commit', 'git.push',
      'codex.open', 'codex.attach', 'server.shutdown', 'direct.reload']) {
      expect(AGENT_REQ_METHODS.has(method)).toBe(false)
    }
    for (const method of ['ui.notify', 'ui.open', 'run.list', 'run.output', 'term.list']) {
      expect(AGENT_REQ_METHODS.has(method)).toBe(true)
    }
  })
})
