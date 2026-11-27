import { describe, expect, it, vi } from 'vitest'
import { MobileTerminals } from './terminals'

const projects = [{ id: 'project', targetId: 'local', path: '/work/demo' }]
const request = { targetId: 'local', projectId: 'project' }

describe('手机终端授权', () => {
  it('按设备与项目授权并只转发已接回的终端', async () => {
    const mobile = new MobileTerminals()
    const opened: Record<string, unknown>[] = []
    const invoke = vi.fn(async (method: string, raw: unknown) => {
      if (method === 'projects.list') return projects
      const outer = raw as { method: string; params: Record<string, unknown> }
      if (outer.method === 'term.open') {
        opened.push(outer.params)
        return { termId: outer.params.termId }
      }
      if (outer.method === 'term.list') return { terminals: [...opened, { termId: 'desktop-term' }] }
      return {}
    })
    await expect(mobile.run(invoke, 'a', 'mobile.term.open', request)).rejects.toMatchObject({ code: 'terminal_disabled' })
    expect(invoke).not.toHaveBeenCalled()
    mobile.setEnabled(true)
    const result = await mobile.run(invoke, 'a', 'mobile.term.open', {
      ...request, shell: 'custom', cwd: '/untrusted', env: { A: 'x' }, termId: 'desktop-term',
    }) as { termId: string }
    expect(opened[0]).toEqual({ termId: result.termId, cwd: '/work/demo', cols: undefined, rows: undefined })
    expect(await mobile.run(invoke, 'a', 'mobile.term.list', request)).toMatchObject({ terminals: [{ termId: result.termId }] })
    expect(await mobile.run(invoke, 'b', 'mobile.term.list', request)).toEqual({ terminals: [] })
    await expect(mobile.run(invoke, 'b', 'mobile.term.attach', { ...request, termId: result.termId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(mobile.run(invoke, 'a', 'mobile.term.attach', { ...request, projectId: 'unknown', termId: result.termId })).rejects.toMatchObject({ code: 'not_found' })

    const output = { targetId: 'local', name: 'term.data', payload: { termId: result.termId, seq: 1, data: 'YQ==' } }
    expect(mobile.toDevice(output)).toBeNull()
    await mobile.run(invoke, 'a', 'mobile.term.attach', { ...request, termId: result.termId, sinceSeq: 0 })
    expect(mobile.toDevice(output)).toEqual({
      deviceId: 'a',
      event: { name: 'mobile.terminal', payload: { ...output, projectId: 'project' } },
    })
    expect(mobile.toDevice({ ...output, targetId: 'remote' })).toBeNull()
    await mobile.run(invoke, 'a', 'mobile.term.detach', { ...request, termId: result.termId })
    expect(mobile.toDevice(output)).toBeNull()
    await mobile.run(invoke, 'a', 'mobile.term.attach', { ...request, termId: result.termId })
    mobile.disconnectDevice('a')
    expect(mobile.toDevice(output)).toBeNull()
  })
})
