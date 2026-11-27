import { expect, it, vi } from 'vitest'
import { mobileProjectFiles } from './projectAccess'

it('使用电脑保存的项目根目录和目标，忽略手机传入的覆盖项', async () => {
  const invoke = vi.fn(async (method: string) => method === 'projects.list'
    ? [{ id: 'one', targetId: 'local', path: '/saved' }]
    : {})
  await mobileProjectFiles(invoke, 'mobile.files.read', {
    projectId: 'one', targetId: 'local', root: '/other', path: 'src/a.ts', offset: 4, length: 8, version: '1',
  })
  expect(invoke).toHaveBeenLastCalledWith('server.req', {
    targetId: 'local', method: 'fs.project.read',
    params: { root: '/saved', path: 'src/a.ts', offset: 4, length: 8, version: '1' },
  })
  await expect(mobileProjectFiles(invoke, 'mobile.files.list', {
    projectId: 'one', targetId: 'other',
  })).rejects.toMatchObject({ code: 'not_found' })
})
