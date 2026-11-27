// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceMethods } from '@qn/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CopyGitRemoteButton } from './CopyGitRemoteButton'

const { serverCall, copyText, setNotice } = vi.hoisted(() => ({
  serverCall: vi.fn(),
  copyText: vi.fn(),
  setNotice: vi.fn(),
}))

vi.mock('../workspace/serverCall', () => ({ serverCall }))
vi.mock('../../lib/clipboard', () => ({ copyText }))
vi.mock('../../store/codex', () => ({ useCodex: { setState: setNotice } }))
vi.mock('../../lib/cn', () => ({ cn: (...classes: string[]) => classes.join(' ') }))
vi.mock('../../components/ui', () => ({
  IconButton: ({ label, children }: PropsWithChildren<{ label: string }>) => <span aria-label={label}>{children}</span>,
}))
vi.mock('../../components/primitives', async () => {
  const { createContext, useContext } = await import('react')
  type MenuState = { open: boolean; onOpenChange: (open: boolean) => void }
  const MenuContext = createContext<MenuState>({ open: false, onOpenChange: () => {} })
  return {
    Menu: ({ children, ...props }: PropsWithChildren<MenuState>) => (
      <MenuContext.Provider value={props}>{children}</MenuContext.Provider>
    ),
    MenuTrigger: ({ children }: PropsWithChildren) => {
      const menu = useContext(MenuContext)
      return <button onClick={() => menu.onOpenChange(!menu.open)}>{children}</button>
    },
    MenuContent: ({ children }: PropsWithChildren) => useContext(MenuContext).open && <div>{children}</div>,
    MenuLabel: ({ children }: PropsWithChildren) => <div>{children}</div>,
    MenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect: () => void }>) => {
      const menu = useContext(MenuContext)
      return <button onClick={() => {
        onSelect()
        menu.onOpenChange(false)
      }}>{children}</button>
    },
  }
})

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  copyText.mockResolvedValue(true)
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

async function renderButton(targetId: string, cwd: string) {
  await act(() => root.render(<CopyGitRemoteButton key={`${targetId}:${cwd}`} targetId={targetId} cwd={cwd} disabled={false} />))
}

async function clickCopy() {
  await act(() => host.querySelector('button')!.click())
}

it('有多个地址时复制用户选择的远端', async () => {
  serverCall.mockResolvedValue({ remotes: [
    { name: 'origin', url: 'https://example.invalid/one.git' },
    { name: 'upstream', url: 'git@example.invalid:two.git' },
  ] })
  await renderButton('remote', '/repos/one')
  await clickCopy()
  expect(serverCall).toHaveBeenCalledWith('remote', 'git.remotes', { cwd: '/repos/one' })
  expect(copyText).not.toHaveBeenCalled()

  const upstream = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('upstream'))
  expect(upstream).toBeDefined()
  await act(() => upstream!.click())
  expect(copyText).toHaveBeenCalledExactlyOnceWith('git@example.invalid:two.git')
  expect(setNotice).toHaveBeenCalledWith({ notice: '已复制 Git 地址' })
})

it('切换项目后忽略旧仓库响应，只复制新仓库的单个地址', async () => {
  type Result = WorkspaceMethods['git.remotes']['result']
  let resolvePrevious: (result: Result) => void = () => {}
  const previous = new Promise<Result>((resolve) => { resolvePrevious = resolve })
  serverCall.mockReturnValueOnce(previous).mockResolvedValueOnce({
    remotes: [{ name: 'origin', url: 'https://example.invalid/new.git' }],
  })
  await renderButton('local', '/repos/old')
  await clickCopy()
  await renderButton('remote', '/repos/new')
  await clickCopy()
  await act(() => resolvePrevious({ remotes: [{ name: 'origin', url: 'https://example.invalid/old.git' }] }))

  expect(serverCall).toHaveBeenLastCalledWith('remote', 'git.remotes', { cwd: '/repos/new' })
  expect(copyText).toHaveBeenCalledExactlyOnceWith('https://example.invalid/new.git')
})
