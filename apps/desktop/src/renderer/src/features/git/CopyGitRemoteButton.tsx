import { useEffect, useRef, useState } from 'react'
import type { GitRemoteAddress } from '@qn/protocol'
import { Copy } from 'lucide-react'
import { LoadingIcon } from '../../components/LoadingIcon'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '../../components/primitives'
import { IconButton } from '../../components/ui'
import { copyText } from '../../lib/clipboard'
import { useCodex } from '../../store/codex'
import { serverCall } from '../workspace/serverCall'
import { describeGitError } from './gitModel'

export function CopyGitRemoteButton({ targetId, cwd, disabled }: {
  targetId: string
  cwd: string
  disabled: boolean
}) {
  const [remotes, setRemotes] = useState<GitRemoteAddress[]>([])
  const [loading, setLoading] = useState(false)
  const pending = useRef<AbortController | null>(null)

  // 切换项目会卸载按钮，旧仓库的响应不能覆盖剪贴板。
  useEffect(() => () => pending.current?.abort(), [])

  const copy = async (url: string): Promise<void> => {
    const ok = await copyText(url)
    useCodex.setState({ notice: ok ? '已复制 Git 地址' : '复制 Git 地址失败' })
  }

  const loadRemotes = async (): Promise<void> => {
    if (pending.current) return
    const request = new AbortController()
    pending.current = request
    setLoading(true)
    try {
      const { remotes } = await serverCall(targetId, 'git.remotes', { cwd })
      if (request.signal.aborted) return
      const [remote] = remotes
      if (!remote) {
        useCodex.setState({ notice: '当前 Git 仓库未配置远端地址' })
      } else if (remotes.length === 1) {
        await copy(remote.url)
      } else {
        setRemotes(remotes)
      }
    } catch (error) {
      if (!request.signal.aborted) {
        useCodex.setState({ notice: describeGitError(error, '读取 Git 远端地址失败').message })
      }
    } finally {
      pending.current = null
      if (!request.signal.aborted) setLoading(false)
    }
  }

  return (
    <Menu
      open={remotes.length > 0}
      onOpenChange={(open: boolean) => {
        if (open) void loadRemotes()
        else setRemotes([])
      }}
    >
      <MenuTrigger asChild>
        <IconButton label="复制 Git 地址" className="h-7 w-7" disabled={disabled} aria-busy={loading}>
          {loading ? <LoadingIcon size={14} /> : <Copy size={14} aria-hidden="true" />}
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="qn-scroll max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
        <MenuLabel>选择要复制的 Git 远端地址</MenuLabel>
        {remotes.map(({ name, url }) => (
          <MenuItem key={JSON.stringify([name, url])} onSelect={() => void copy(url)}>
            <span className="block truncate font-medium">{name}</span>
            <span className="block whitespace-normal break-all text-ui-xs text-qn-muted">{url}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
