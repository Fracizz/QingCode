import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  emit: undefined as undefined | ((payload: unknown) => void),
}))
vi.mock('./tauri', () => ({ safeInvoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.emit = payload => handler({ payload })
    return () => { mocks.emit = undefined }
  }),
}))
vi.mock('./projectRepository', () => ({ getSshConnection: vi.fn(), upsertSshConnection: vi.fn(), listSshConnections: vi.fn(async () => []) }))
vi.mock('./sshServerSettings', () => ({ getSshServerEnabled: () => true, loadSshPreparationSettings: vi.fn(async () => ({})) }))
vi.mock('./workspaceTrust', () => ({ isProjectTrusted: () => true }))

import { prepareSshWorkspace } from './sshWorkspace'
import { beginServerOperation, useServerOperationStore } from '../store/serverOperationStore'

const project: Project = { id: 'p1', connection_id: 'c1', path: 'ssh://c1/project', name: 'nem-panel', kind: 'ssh', created_at: 1, last_opened_at: 1 }
const state = (phase: string, extra: Record<string, unknown> = {}) => ({
  rootUri: project.path, connectionId: 'c1', phase, mode: 'server', connectionMode: 'server', transport: 'agent', version: null, reason: null, ...extra,
})

/** 准备过程中按顺序推送后端阶段，返回准备完成时的任务快照。 */
async function prepareWith(phases: unknown[]) {
  const seen: ReturnType<typeof useServerOperationStore.getState>['tasks'][string][] = []
  mocks.invoke.mockImplementation(async (_label: string, command: string) => {
    if (command !== 'ssh_prepare_workspace') return undefined
    for (const phase of phases) {
      mocks.emit?.(phase)
      const task = useServerOperationStore.getState().tasks[project.path]
      if (task) seen.push(task)
    }
  })
  await prepareSshWorkspace(project.path, new AbortController().signal, () => {}, { project, background: true })
  return seen
}

beforeEach(() => {
  vi.clearAllMocks()
  useServerOperationStore.setState({ tasks: {} })
})

describe('shared Server install progress', () => {
  it('titles the card as the connection-shared service, not the project that triggered it', async () => {
    const seen = await prepareWith([state('installing'), state('handshaking')])
    expect(seen[0]).toMatchObject({ name: '远端服务', kind: 'install', step: 3, label: '安装 QingCode Server' })
    expect(seen[1]).toMatchObject({ step: 4, label: '正在验证远端服务与配对身份…' })
    expect(useServerOperationStore.getState().tasks[project.path].finishedAt).toBeDefined()
  })

  it('shows an update when the backend reports it is replacing an older service', async () => {
    const seen = await prepareWith([state('installing', { upgrading: true }), state('handshaking', { upgrading: true })])
    expect(seen[0]).toMatchObject({ kind: 'update', label: '更新 QingCode Server' })
    expect(seen[1]).toMatchObject({ kind: 'update', step: 4 })
  })

  it('switches an install card to update when the flag arrives with the handshake', async () => {
    const seen = await prepareWith([state('installing'), state('handshaking', { upgrading: true })])
    expect(seen[0].kind).toBe('install')
    expect(seen[1].kind).toBe('update')
  })

  it('reuses the running task of another project on the same connection', async () => {
    beginServerOperation('ssh://c1/other', '远端服务', 'update')
    await prepareWith([state('installing'), state('handshaking')])
    const tasks = useServerOperationStore.getState().tasks
    expect(tasks[project.path]).toBeUndefined()
    expect(tasks['ssh://c1/other'].finishedAt).toBeUndefined()
  })

  it('leaves tasks owned by the update dialog for that dialog to finish', async () => {
    beginServerOperation(project.path, '远端服务', 'update')
    await prepareWith([state('installing'), state('handshaking')])
    const task = useServerOperationStore.getState().tasks[project.path]
    expect(task.finishedAt).toBeUndefined()
    expect(task.step).toBe(1)
  })
})
