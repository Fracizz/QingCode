import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DIRECT_CODE_PREFIX, decodeDirectCode, type DirectInfo } from '@qn/protocol'
import type {
  DirectTarget,
  DirectTargetInput,
  EnableDirectParams,
  SshAuth,
  SshDirect,
  SshTarget,
  SshTargetInput,
  TargetProbe,
} from '../../../shared/backendApi'
import { FeedbackRow } from './FeedbackRow'
import { FormField } from './FormField'
import { PasswordInput } from './PasswordInput'
import type { ConnectCredentials } from '../store/targets'
import { useTargets } from '../store/targets'
import { friendlyError } from '../lib/errors'
import { Select } from './primitives'
import { Checkbox, ErrorNote, IconButton, Modal } from './ui'
import { CircleCheck, Folder } from 'lucide-react'

type Draft = {
  name: string
  host: string
  port: string
  username: string
  authKind: 'password' | 'key' | 'agent'
  keyPath: string
  password: string
  passphrase: string
  remember: boolean
}

const emptyDraft: Draft = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  authKind: 'password',
  keyPath: '',
  password: '',
  passphrase: '',
  // 默认记住：多数用户期望下次连接不再输入；可取消勾选。
  remember: true,
}

function draftFrom(target: SshTarget): Draft {
  return {
    ...emptyDraft,
    name: target.name,
    host: target.host,
    port: String(target.port),
    username: target.username,
    authKind: target.auth.kind,
    keyPath: target.auth.kind === 'key' ? target.auth.keyPath : '',
  }
}

type DirectDraft = {
  name: string
  host: string
  port: string
}

const emptyDirectDraft: DirectDraft = { name: '', host: '', port: '' }

function directDraftFrom(info: DirectInfo): DirectDraft {
  const host = info.hosts[0] ?? ''
  return { name: info.name ?? `直连 ${host}`.trim(), host, port: String(info.port) }
}

/** 编辑时没有连接码，用目标本身拼出同形状的数据；token 留空表示沿用已保存的授权。 */
function directInfoFromTarget(target: DirectTarget): DirectInfo {
  return {
    v: 1,
    hosts: [target.host],
    port: target.port,
    token: '',
    fingerprint: target.fingerprint,
    name: target.name,
  }
}

/**
 * 从粘贴文本里挑出连接码：终端输出常夹带说明文字、折行与标点。
 * 取前缀后连续的码字符，再逐字回退到能解出合法码的最长前缀。
 */
export function extractDirectInfo(text: string): DirectInfo | null {
  for (let from = 0; ; ) {
    const start = text.indexOf(DIRECT_CODE_PREFIX, from)
    if (start < 0) return null
    from = start + DIRECT_CODE_PREFIX.length
    const match = /^[A-Za-z0-9_=\-\s]+/.exec(text.slice(from))
    if (!match) continue
    const body = (match[0] ?? '').replace(/\s+/g, '').replace(/=+$/, '')
    const limit = Math.max(1, body.length - 512)
    for (let end = body.length; end >= limit; end--) {
      const info = decodeDirectCode(DIRECT_CODE_PREFIX + body.slice(0, end))
      if (info) return info
    }
  }
}

export function TargetForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: SshTarget | DirectTarget
  onClose: () => void
  onSaved: (target: SshTarget | DirectTarget, credentials: ConnectCredentials) => void
}) {
  const save = useTargets((s) => s.save)
  const test = useTargets((s) => s.test)
  const enableDirect = useTargets((s) => s.enableDirect)
  const disableDirect = useTargets((s) => s.disableDirect)
  const [mode, setMode] = useState<'ssh' | 'direct'>(initial?.kind === 'direct' ? 'direct' : 'ssh')
  const [draft, setDraft] = useState<Draft>(() => (initial?.kind === 'ssh' ? draftFrom(initial) : emptyDraft))
  const [directDraft, setDirectDraft] = useState<DirectDraft>(() =>
    initial?.kind === 'direct' ? directDraftFrom(directInfoFromTarget(initial)) : emptyDirectDraft,
  )
  const [codeInfo, setCodeInfo] = useState<DirectInfo | null>(() =>
    initial?.kind === 'direct' ? directInfoFromTarget(initial) : null,
  )
  const [codeText, setCodeText] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [directConfig, setDirectConfig] = useState({
    listen: '47390',
    host: initial?.kind === 'ssh' ? initial.host : '',
    allowPublic: false,
  })
  const [sshDirect, setSshDirect] = useState<SshDirect | undefined>(initial?.kind === 'ssh' ? initial.direct : undefined)
  // 新建后测试失败时对话框保留：记下 id，再次保存是更新而不是又建一条。
  const [sshSavedId, setSshSavedId] = useState(initial?.kind === 'ssh' ? initial.id : undefined)
  const [directSavedId, setDirectSavedId] = useState(initial?.kind === 'direct' ? initial.id : undefined)
  const [busy, setBusy] = useState<'test' | 'save' | 'enable' | 'disable' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [passed, setPassed] = useState<string | null>(null)
  const alive = useRef(true)
  const lastCode = useRef<string | null>(null)
  const sshId = initial?.kind === 'ssh' ? initial.id : undefined
  const patch = (part: Partial<Draft>) => {
    setDraft((value) => ({ ...value, ...part }))
    setPassed(null)
  }
  const patchDirect = (part: Partial<DirectDraft>) => setDirectDraft((value) => ({ ...value, ...part }))

  // 测试途中关掉对话框后，迟到的结果不能再触发连接。
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** 校验表单；不通过时写入错误并返回 null。 */
  const buildInput = (): SshTargetInput | null => {
    setError(null)
    setPassed(null)
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('端口需为 1–65535 的整数')
      return null
    }
    const host = draft.host.trim()
    if (!host) {
      setError('主机不能为空')
      return null
    }
    let auth: SshAuth
    if (draft.authKind === 'key') {
      if (!draft.keyPath.trim()) {
        setError('请选择私钥文件')
        return null
      }
      auth = { kind: 'key', keyPath: draft.keyPath.trim() }
    } else if (draft.authKind === 'password') {
      auth = { kind: 'password' }
    } else {
      auth = { kind: 'agent' }
    }
    return {
      ...(sshSavedId ? { id: sshSavedId } : {}),
      name: draft.name.trim() || `${draft.username.trim() || 'root'}@${host}`,
      host,
      port,
      username: draft.username.trim() || 'root',
      auth,
    }
  }

  const typedCredentials = (): ConnectCredentials => {
    const credentials: ConnectCredentials = { remember: draft.remember }
    if (draft.authKind === 'password' && draft.password) credentials.password = draft.password
    if (draft.authKind === 'key' && draft.passphrase) credentials.passphrase = draft.passphrase
    return credentials
  }

  const switchMode = (next: 'ssh' | 'direct') => {
    setMode(next)
    setError(null)
    setPassed(null)
    setCodeError(null)
  }

  const applyCode = (text: string) => {
    setCodeText(text)
    if (!text.trim()) {
      setCodeInfo(null)
      setCodeError(null)
      lastCode.current = null
      return
    }
    const info = extractDirectInfo(text)
    if (!info) {
      setCodeInfo(null)
      setCodeError('连接码无效')
      lastCode.current = null
      return
    }
    setCodeInfo(info)
    setCodeError(null)
    setError(null)
    setPassed(null)
    // 同一段码被微调时不要覆盖用户已经改过的名称/主机。
    const key = `${info.fingerprint}:${info.port}:${info.token}`
    if (lastCode.current !== key) {
      lastCode.current = key
      setDirectDraft(directDraftFrom(info))
      setDirectSavedId(undefined)
    }
  }

  const buildDirectInput = (): DirectTargetInput | null => {
    setError(null)
    setPassed(null)
    if (!codeInfo) {
      setError('连接码无效')
      return null
    }
    const port = Number(directDraft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('端口需为 1–65535 的整数')
      return null
    }
    const host = directDraft.host.trim()
    if (!host) {
      setError('主机不能为空')
      return null
    }
    return {
      ...(directSavedId ? { id: directSavedId } : {}),
      kind: 'direct',
      name: directDraft.name.trim() || `直连 ${host}`,
      host,
      port,
      fingerprint: codeInfo.fingerprint,
      ...(codeInfo.token ? { token: codeInfo.token } : {}),
    }
  }

  const directCredentials = (): { password?: string; passphrase?: string } => ({
    ...(draft.authKind === 'password' && draft.password ? { password: draft.password } : {}),
    ...(draft.authKind === 'key' && draft.passphrase ? { passphrase: draft.passphrase } : {}),
  })

  const runEnableDirect = async () => {
    if (!sshId) {
      setError('请先保存 SSH 连接，再开启直连加速')
      return
    }
    const listen = Number(directConfig.listen.trim() || '47390')
    if (!Number.isInteger(listen) || listen < 1 || listen > 65535) {
      setError('远端监听端口需为 1–65535 的整数')
      return
    }
    setError(null)
    setBusy('enable')
    try {
      const params: EnableDirectParams = {
        id: sshId,
        listen: String(listen),
        ...(directConfig.host.trim() ? { host: directConfig.host.trim() } : {}),
        allowPublic: directConfig.allowPublic,
        ...directCredentials(),
      }
      setSshDirect((await enableDirect(params)).direct)
    } catch (err) {
      setError(friendlyError(err, '开启直连加速失败'))
    } finally {
      setBusy(null)
    }
  }

  const runDisableDirect = async () => {
    if (!sshId) return
    setError(null)
    setBusy('disable')
    try {
      setSshDirect((await disableDirect(sshId, directCredentials())).direct)
    } catch (err) {
      setError(friendlyError(err, '关闭直连加速失败'))
    } finally {
      setBusy(null)
    }
  }

  const describeProbe = ({ os, nodeVersion }: TargetProbe) => `连接成功：${os} · Node ${nodeVersion}`

  const runTest = async () => {
    const input = buildInput()
    if (!input) return
    try {
      setBusy('test')
      setPassed(describeProbe(await test(input, typedCredentials())))
    } catch (err) {
      setError(friendlyError(err, '连接测试失败'))
    } finally {
      setBusy(null)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = buildInput()
    if (!input) return
    setBusy('save')
    let target: SshTarget | DirectTarget
    try {
      target = await save(input)
      setSshSavedId(target.id)
    } catch (err) {
      setError(friendlyError(err, '保存连接失败'))
      setBusy(null)
      return
    }
    try {
      const credentials = typedCredentials()
      await test({ ...input, id: target.id }, credentials)
      if (!alive.current) return
      onSaved(target, credentials)
      onClose()
    } catch (err) {
      setError(`配置已保存，但连接测试失败：${friendlyError(err, '未知错误')}`)
    } finally {
      setBusy(null)
    }
  }

  const submitDirect = async (event: FormEvent) => {
    event.preventDefault()
    const input = buildDirectInput()
    if (!input) return
    setBusy('save')
    try {
      const target = await save(input)
      if (target.kind === 'direct') setDirectSavedId(target.id)
      if (!alive.current) return
      onSaved(target, {})
      onClose()
    } catch (err) {
      setError(friendlyError(err, '保存直连目标失败'))
    } finally {
      setBusy(null)
    }
  }

  const pickKey = async () => {
    if (typeof window === 'undefined') return
    try {
      const path = await window.qn.openFile()
      if (path) patch({ keyPath: path })
    } catch (err) {
      setError(friendlyError(err, '选择私钥文件失败'))
    }
  }

  const secretLabel = draft.authKind === 'key'
    ? '私钥口令（可选）'
    : initial ? '密码（留空则使用已保存的密码）' : '密码（连接时使用）'
  const directMode = mode === 'direct'
  const modalTitle = initial
    ? (directMode ? '编辑直连目标' : '编辑 SSH 连接')
    : (directMode ? '添加直连目标' : '添加 SSH 连接')

  return (
    <Modal
      title={modalTitle}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          {!directMode && (
            <button className="qn-button-subtle mr-auto" type="button" disabled={busy !== null}
              onClick={() => void runTest()}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
          )}
          <button className="qn-button-subtle" type="button" onClick={onClose}>
            取消
          </button>
          <button className="qn-button" type="submit" form="target-form" disabled={busy !== null}>
            {busy === 'save' ? (directMode ? '保存中…' : '保存并测试中…') : '保存'}
          </button>
        </div>
      }
    >
      <form id="target-form" className="space-y-2"
        onSubmit={(event) => void (directMode ? submitDirect(event) : submit(event))}>
        {!initial && (
          <div className="flex gap-1 rounded-lg border border-qn-border bg-qn-bg p-1">
            <button type="button" onClick={() => switchMode('ssh')}
              className={`h-8 flex-1 rounded-lg px-3 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-accent ${mode === 'ssh' ? 'bg-qn-hover text-qn-text' : 'text-qn-muted hover:text-qn-text'}`}>
              SSH 连接
            </button>
            <button type="button" onClick={() => switchMode('direct')}
              className={`h-8 flex-1 rounded-lg px-3 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-accent ${mode === 'direct' ? 'bg-qn-hover text-qn-text' : 'text-qn-muted hover:text-qn-text'}`}>
              直连（连接码）
            </button>
          </div>
        )}
        {directMode ? (
          <div className="space-y-2">
            {!initial && (
              <>
                <textarea
                  className="qn-input min-h-20 resize-y font-mono text-ui-sm leading-5"
                  rows={3}
                  placeholder="粘贴 qn-direct: 开头的连接码（可连同前后其它文字一起复制）"
                  value={codeText}
                  onChange={(event) => applyCode(event.target.value)}
                />
                <ErrorNote message={codeError} onClose={() => setCodeError(null)} />
              </>
            )}
            {codeInfo && (
              <>
                <input className="qn-input" placeholder="名称" value={directDraft.name}
                  onChange={(event) => patchDirect({ name: event.target.value })} />
                {codeInfo.hosts.length > 1 && (
                  <Select
                    aria-label="候选拨号地址"
                    value={codeInfo.hosts.includes(directDraft.host) ? directDraft.host : ''}
                    onValueChange={(value) => patchDirect({ host: value })}
                    options={codeInfo.hosts.map((host) => ({ value: host, label: host }))}
                    placeholder="选择候选地址，也可在下方手动输入"
                  />
                )}
                <div className="flex gap-2">
                  <input className="qn-input min-w-0 flex-1" placeholder="主机" value={directDraft.host}
                    onChange={(event) => patchDirect({ host: event.target.value })} />
                  <input className="qn-input w-20" placeholder="端口" inputMode="numeric" value={directDraft.port}
                    onChange={(event) => patchDirect({ port: event.target.value })} />
                </div>
                <div className="rounded-lg border border-qn-border px-3 py-2 text-ui-sm leading-5 text-qn-muted">
                  证书指纹 <span className="font-mono text-qn-text">{codeInfo.fingerprint.slice(0, 16)}…</span>（只读）
                </div>
              </>
            )}
          </div>
        ) : (
          <>
          <input className="qn-input" placeholder="名称" value={draft.name}
            onChange={(e) => patch({ name: e.target.value })} />
          <div className="flex gap-2">
            <input className="qn-input min-w-0 flex-1" placeholder="主机" value={draft.host}
              onChange={(e) => patch({ host: e.target.value })} />
            <input className="qn-input w-20" placeholder="端口" inputMode="numeric" value={draft.port}
              onChange={(e) => patch({ port: e.target.value })} />
          </div>
          <input className="qn-input" placeholder="用户名" value={draft.username}
            onChange={(e) => patch({ username: e.target.value })} />
          <Select
            aria-label="认证方式"
            value={draft.authKind}
            onValueChange={(value) => patch({ authKind: value as Draft['authKind'] })}
            options={[
              { value: 'password', label: '密码' },
              { value: 'key', label: '私钥文件' },
              { value: 'agent', label: 'ssh-agent' },
            ]}
          />
          {draft.authKind === 'key' && (
            <div className="flex gap-2">
              <input className="qn-input min-w-0 flex-1" placeholder="私钥路径" value={draft.keyPath}
                onChange={(e) => patch({ keyPath: e.target.value })} />
              <IconButton label="选择私钥文件" onClick={() => void pickKey()}>
                <Folder size={14} />
              </IconButton>
            </div>
          )}
          {(draft.authKind === 'password' || draft.authKind === 'key') && (
            <>
              <PasswordInput placeholder={initial?.kind === 'ssh' && initial.hasSavedSecret ? `${secretLabel}（已保存，留空沿用）` : secretLabel}
                value={draft.authKind === 'key' ? draft.passphrase : draft.password}
                onChange={(e) => patch(draft.authKind === 'key' ? { passphrase: e.target.value } : { password: e.target.value })} />
              <Checkbox checked={draft.remember} onChange={(value) => patch({ remember: value })}>
                记住密码 / 口令（用本机系统加密保存）
              </Checkbox>
              <p className="text-ui-sm leading-5 text-qn-muted">
                凭据只在连接时传给 backend，不写入连接配置。
              </p>
            </>
          )}
          {initial?.kind === 'ssh' && (
            <div className="mt-3 space-y-2 rounded-lg border border-qn-border px-3 py-2.5">
              <div className="text-ui font-medium text-qn-text">直连加速</div>
              {sshDirect ? (
                <>
                  <div className="text-ui-sm leading-5 text-qn-muted">
                    已开启：<span className="font-mono text-qn-text">{sshDirect.host}:{sshDirect.port}</span>
                    {' · '}指纹 <span className="font-mono text-qn-text">{sshDirect.fingerprint.slice(0, 16)}…</span>
                  </div>
                  <button className="qn-button-subtle" type="button" disabled={busy !== null}
                    onClick={() => void runDisableDirect()}>
                    {busy === 'disable' ? '正在关闭…' : '关闭直连加速'}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-ui-sm leading-5 text-qn-muted">
                    经 SSH 在远端开启 TLS 直连，之后连接优先直连、失败自动回退 SSH
                  </p>
                  <div className="flex gap-2">
                    <FormField label="远端监听端口" className="flex-1">
                      {(control) => (
                        <input {...control} className="qn-input" placeholder="47390" inputMode="numeric" value={directConfig.listen}
                          onChange={(event) => setDirectConfig((value) => ({ ...value, listen: event.target.value }))} />
                      )}
                    </FormField>
                    <FormField label="拨号地址" className="flex-1">
                      {(control) => (
                        <input {...control} className="qn-input" placeholder="可填 frp / Tailscale 地址" value={directConfig.host}
                          onChange={(event) => setDirectConfig((value) => ({ ...value, host: event.target.value }))} />
                      )}
                    </FormField>
                  </div>
                  <Checkbox checked={directConfig.allowPublic}
                    onChange={(checked) => setDirectConfig((value) => ({ ...value, allowPublic: checked }))}>
                    允许公网来源（不推荐）
                  </Checkbox>
                  <button className="qn-button-subtle" type="button" disabled={busy !== null}
                    onClick={() => void runEnableDirect()}>
                    {busy === 'enable' ? '正在开启…' : '开启直连加速'}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      <FeedbackRow
        message={passed}
        icon={<CircleCheck size={15} />}
        className="rounded-lg border border-qn-ok/30 bg-qn-ok/10 px-3 py-2 text-ui leading-5 text-qn-ok"
      />
      <ErrorNote message={error} onClose={() => setError(null)} />
      </form>
    </Modal>
  )
}
