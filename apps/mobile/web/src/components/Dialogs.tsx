import { useState } from 'react'
import { joinPath } from '../state'
import { useApp } from '../store'
import { Button, Dialog, Loading, Note } from './ui'

export function CredentialDialog() {
  const prompt = useApp((s) => s.credential)
  const cancel = useApp((s) => s.cancelCredentials)
  const submit = useApp((s) => s.submitCredentials)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)

  if (!prompt) return null
  return (
    <Dialog title={`连接 ${prompt.name}`} onClose={cancel}>
      <p className="mb-3 text-xs text-qn-muted">
        此目标使用密码认证。留空则使用电脑上已保存的密码；新主机指纹请在电脑端确认。
      </p>
      <label className="qn-label" htmlFor="qn-password">
        密码
      </label>
      <input
        id="qn-password"
        className="qn-input mb-3"
        type="password"
        value={password}
        autoComplete="off"
        onChange={(event) => setPassword(event.target.value)}
      />
      <label className="mb-3 flex min-h-[44px] items-center gap-2 text-sm">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        在电脑上记住此密码
      </label>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={cancel}>
          取消
        </Button>
        <Button
          className="flex-1"
          variant="primary"
          onClick={() => {
            setPassword('')
            void submit(password, remember)
          }}
        >
          连接
        </Button>
      </div>
    </Dialog>
  )
}

export function DirectoryDialog() {
  const directory = useApp((s) => s.directory)
  const browse = useApp((s) => s.browseDirectory)
  const close = useApp((s) => s.closeDirectory)
  const choose = useApp((s) => s.chooseDirectory)
  if (!directory) return null

  return (
    <Dialog title="添加项目" onClose={close}>
      <div className="qn-mono mb-2 break-all rounded-lg border border-qn-border bg-black/20 p-2 text-[11px]">
        {directory.path || '（正在读取主目录…）'}
      </div>
      {directory.error && <Note message={directory.error} tone="error" />}
      {directory.loading ? (
        <Loading text="读取目录…" />
      ) : (
        <div className="qn-scroll mb-3 max-h-[45vh] overflow-y-auto">
          {directory.parent && (
            <button
              type="button"
              className="qn-row border-b border-qn-border"
              onClick={() => void browse(directory.parent ?? '')}
            >
              <span>↑ 上一级</span>
            </button>
          )}
          {directory.entries.length === 0 && (
            <div className="py-4 text-center text-xs text-qn-muted">此目录下没有子目录</div>
          )}
          {directory.entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className="qn-row border-b border-qn-border"
              onClick={() => void browse(joinPath(directory.path, entry.name))}
            >
              <span className="min-w-0 flex-1 truncate">📁 {entry.name}</span>
              <span className="text-qn-muted">›</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button className="flex-1" onClick={close}>
          取消
        </Button>
        <Button
          className="flex-1"
          variant="primary"
          disabled={!directory.path || directory.saving}
          onClick={() => void choose()}
        >
          {directory.saving ? '保存中…' : '选择此目录'}
        </Button>
      </div>
    </Dialog>
  )
}
