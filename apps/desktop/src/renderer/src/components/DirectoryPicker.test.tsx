// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackendCallError, call } from '../lib/backend'
import { DirectoryPicker } from './DirectoryPicker'
import type { EmptyState, ErrorNote, IconButton, Modal } from './ui'

vi.mock('../lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/backend')>()),
  call: vi.fn(),
}))

vi.mock('./ui', () => ({
  Modal: ({ children, footer }: ComponentProps<typeof Modal>) => <section>{children}{footer}</section>,
  EmptyState: ({ children }: ComponentProps<typeof EmptyState>) => <div>{children}</div>,
  ErrorNote: ({ message }: ComponentProps<typeof ErrorNote>) => message ? <div role="alert">{message}</div> : null,
  IconButton: ({ label, ...props }: ComponentProps<typeof IconButton>) => <button aria-label={label} {...props} />,
  Spinner: () => null,
}))

const request = vi.mocked(call)
const confirm = vi.fn()
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  request.mockReset()
  confirm.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const button = (label: string) => {
  const control = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  if (!control) throw new Error('未找到操作按钮 ' + label)
  return control
}

const click = (label: string) => act(() => button(label).click())

const fill = (selector: string, value: string) => act(() => {
  const field = host.querySelector<HTMLInputElement>(selector)
  if (!field) throw new Error('未找到输入框 ' + selector)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

const list = (path: string, ...names: string[]) => ({
  path,
  entries: names.map((name) => ({ name, kind: 'dir' })),
})

const render = (targetId: string, path: string, ...names: string[]) => {
  request.mockResolvedValueOnce({ path }).mockResolvedValueOnce(list(path, ...names))
  return act(() => root.render(<DirectoryPicker targetId={targetId} onClose={vi.fn()} onConfirm={confirm} />))
}

it('在已浏览的本机目录中创建子目录，进入后可直接选为项目', async () => {
  await render('local', '/projects')
  await fill('input[placeholder^="目录绝对路径"]', '/尚未转到')
  await click('新建目录')
  await fill('[aria-label="目录名称"]', '新项目')
  request.mockResolvedValueOnce({}).mockResolvedValueOnce(list('/projects/新项目'))
  await click('创建')

  expect(request).toHaveBeenNthCalledWith(3, 'server.req', {
    targetId: 'local', method: 'fs.mkdir', params: { path: '/projects/新项目', recursive: false },
  })
  expect(request).toHaveBeenNthCalledWith(4, 'server.req', {
    targetId: 'local', method: 'fs.list', params: { path: '/projects/新项目', dirsOnly: true },
  })
  await click('选择当前目录')
  expect(confirm).toHaveBeenCalledExactlyOnceWith('/projects/新项目')
})

it('对选中的 SSH 目标目录重命名，刷新后选中新名称', async () => {
  const path = 'C:\\Users\\test'
  await render('ssh-windows', path, 'old')
  expect(button('重命名').disabled).toBe(true)
  await click('old')
  await click('重命名')
  expect(host.querySelector<HTMLInputElement>('[aria-label="新目录名称"]')?.value).toBe('old')
  await fill('[aria-label="新目录名称"]', 'new')
  request.mockResolvedValueOnce({}).mockResolvedValueOnce(list(path, 'new'))
  await click('保存')

  expect(request).toHaveBeenNthCalledWith(3, 'server.req', {
    targetId: 'ssh-windows', method: 'fs.rename', params: { from: path + '\\old', to: path + '\\new' },
  })
  expect(request).toHaveBeenNthCalledWith(4, 'server.req', {
    targetId: 'ssh-windows', method: 'fs.list', params: { path, dirsOnly: true },
  })
  expect(button('new').getAttribute('aria-pressed')).toBe('true')
})

it('阻止路径片段和同名目录，服务端拒绝后保留名称以便重试', async () => {
  await render('local', '/projects', '已有目录')
  await click('新建目录')
  await fill('[aria-label="目录名称"]', '../outside')
  await click('创建')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('路径分隔符')
  await fill('[aria-label="目录名称"]', '已有目录')
  await click('创建')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('同名')
  expect(request).toHaveBeenCalledTimes(2)

  await fill('[aria-label="目录名称"]', '被占用')
  request.mockRejectedValueOnce(new BackendCallError('exists', '目标已存在'))
  await click('创建')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('同名')
  expect(host.querySelector<HTMLInputElement>('[aria-label="目录名称"]')?.value).toBe('被占用')
  expect(button('创建').disabled).toBe(false)
})
