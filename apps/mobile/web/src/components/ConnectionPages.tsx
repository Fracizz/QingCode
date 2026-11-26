import { Plus, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { callDevice, getGateway } from '../client'
import { formatAddress, isValidPairingCode, normalizeFingerprint, parseAddress, parsePairingLink } from '../link'
import { getWindowNativePort } from '../native'
import { friendlyError } from '../state'
import { useApp } from '../store'
import type { ConnectionStatus } from '../types'
import { PullToRefresh } from './PullToRefresh'
import { Badge, Button, Card, Dialog, Empty, Field, Header, Loading, Note, StatusDot } from './ui'
import { WorkspaceIcon } from './WorkspaceHome'

const stateText: Record<ConnectionStatus, string> = {
  online: '在线',
  offline: '离线',
  mismatch: '证书已变化',
  checking: '检测中…',
  unknown: '待连接',
}

function statusTone(status: ConnectionStatus): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'online') return 'ok'
  if (status === 'checking') return 'warn'
  if (status === 'mismatch') return 'danger'
  return 'muted'
}

type UpdateCheck = { available: boolean; versionName: string; versionCode: number; id?: string }
const UPDATE_URL = 'mobile.updateUrl'

function MobileSettings({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [candidate, setCandidate] = useState<UpdateCheck | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const native = Boolean(getWindowNativePort())

  useEffect(() => {
    if (!native) return
    let cancelled = false
    void callDevice<{ versionName: string; online: boolean }>('updates.status').then((result) => {
      if (!cancelled) {
        setVersion(result.versionName)
        setOnline(result.online)
      }
    }).catch((err: unknown) => {
      if (!cancelled) setError(friendlyError(err, '无法读取应用版本'))
    })
    void getGateway().storageGet(UPDATE_URL).then((value) => {
      if (!cancelled && value) setUrl(value)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [native])

  const check = async () => {
    setNotice(null)
    setError(null)
    setCandidate(null)
    let endpoint: URL
    try {
      endpoint = new URL(url.trim())
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error()
    } catch {
      setError('请输入 HTTPS APK 下载地址。')
      return
    }
    setBusy('check')
    try {
      await getGateway().storageSet(UPDATE_URL, endpoint.href)
      const result = await callDevice<UpdateCheck>('updates.check', { url: endpoint.href }, 300_000)
      setCandidate(result)
      if (!result.available) setNotice('当前已是此地址提供的最新版本。')
    } catch (err) {
      setError(friendlyError(err, '检查更新失败'))
    } finally {
      setBusy(null)
    }
  }

  const install = async (id?: string) => {
    setError(null)
    setNotice(null)
    setBusy('install')
    try {
      const result = await callDevice<{ started: boolean }>('updates.install', id ? { id } : {}, 300_000)
      if (result.started) setNotice('在 Android 系统界面中确认安装。')
    } catch (err) {
      setError(friendlyError(err, '无法安装所选 APK'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog title="应用设置" onClose={onClose}>
      <p className="mb-3 text-sm">QingCode Next{version ? ` · ${version}` : ''}</p>
      <p className="mb-4 text-xs text-qn-muted">QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系。Agent 用量计入你自己的账号。</p>
      {error && <Note tone="error" message={error} />}
      {notice && <Note message={notice} />}
      {online && (
        <>
          <Field label="更新地址" hint="填写你信任的 HTTPS APK 下载地址。">
            <input className="qn-input" type="url" value={url} disabled={busy !== null}
              onChange={(event) => { setUrl(event.target.value); setCandidate(null) }}
              autoCapitalize="off" spellCheck={false} placeholder="https://…" />
          </Field>
          {candidate?.available && candidate.id ? (
            <Button className="mb-2 w-full" variant="primary" disabled={busy !== null} onClick={() => void install(candidate.id)}>
              {busy === 'install' ? '正在检查安装包…' : `安装 ${candidate.versionName}`}
            </Button>
          ) : (
            <Button className="mb-2 w-full" variant="primary" disabled={busy !== null || !url.trim()} onClick={() => void check()}>
              {busy === 'check' ? '正在下载并验证更新…' : '检查更新'}
            </Button>
          )}
        </>
      )}
      {native && (
        <Button className="w-full" disabled={busy !== null} onClick={() => void install()}>
          从本地 APK 更新
        </Button>
      )}
    </Dialog>
  )
}

export function ConnectionsPage() {
  const connections = useApp((s) => s.connections)
  const statuses = useApp((s) => s.connectionStatus)
  const latencies = useApp((s) => s.connectionLatencyMs)
  const activeId = useApp((s) => s.activeId)
  const booting = useApp((s) => s.booting)
  const mock = useApp((s) => s.mock)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const eventsError = useApp((s) => s.eventsError)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const needsRepair = useApp((s) => s.needsRepair)
  const beginRepair = useApp((s) => s.beginRepair)
  const activate = useApp((s) => s.activate)
  const openAddForm = useApp((s) => s.openAddForm)
  const openEditForm = useApp((s) => s.openEditForm)
  const removeConnection = useApp((s) => s.removeConnection)
  const pasteFromClipboard = useApp((s) => s.pasteFromClipboard)
  const refreshStatuses = useApp((s) => s.refreshStatuses)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const [menu, setMenu] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  useEffect(() => {
    if (!booting && connections.length) void refreshStatuses()
  }, [booting, connections, refreshStatuses])

  const selected = connections.find((item) => item.id === menu)
  const addFromClipboard = () => {
    openAddForm()
    void pasteFromClipboard()
  }
  return (
    <>
      <PullToRefresh className="qn-body qn-scroll qn-workspace qn-rise"
        label="连接" disabled={booting || connections.length === 0} onRefresh={refreshStatuses}>
        <header className="qn-workspace-title" data-connected={eventsConnected}>
          <div className="qn-workspace-context">
            <span className="text-[13px]">{mock ? '浏览器预览' : connections.length ? `已配对 ${connections.length} 台电脑` : 'QingCode Next'}</span>
            <div className="flex">
              {activeId && eventsConnected && !needsRepair[activeId] && (
                <Button variant="ghost" className="px-2 text-xs" onClick={() => void activate(activeId, 'targets')}>目标与额度</Button>
              )}
              {connections.length > 0 && (
                <Button variant="ghost" className="qn-list-action" onClick={() => void refreshStatuses()} aria-label="刷新连接">
                  <WorkspaceIcon name="refresh" />
                </Button>
              )}
              <Button variant="ghost" className="qn-list-action" onClick={() => setSettings(true)} aria-label="应用设置">
                <Settings size={20} strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        </header>
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {eventsError && activeId && !needsRepair[activeId] && <Note message={eventsError} tone="warn" />}
        {booting ? <Loading text="正在读取已保存的连接…" /> : connections.length === 0 ? (
          <Empty>
            <p>在电脑端「手机连接」复制连接信息。</p>
            <div className="mt-4 flex flex-col gap-2">
              <Button variant="primary" onClick={addFromClipboard}>从剪贴板导入</Button>
              <button type="button" className="qn-dashed-action qn-pressable mt-0" onClick={openAddForm}>
                <Plus size={17} aria-hidden />添加连接
              </button>
            </div>
          </Empty>
        ) : (
          <>
            <div className="qn-list-group">
              {connections.map((conn) => {
                const current = conn.id === activeId
                const repair = needsRepair[conn.id]
                const status = current && eventsConnected ? 'online' : statuses[conn.id] ?? 'unknown'
                const tone = repair ? 'danger' : statusTone(status)
                const latency = !repair && status === 'online' ? latencies[conn.id] : null
                return (
                  <div key={conn.id} className="qn-row qn-list-row">
                    <button type="button" className="qn-row-trigger" onClick={() => void activate(conn.id, 'targets')}>
                      <StatusDot tone={tone} />
                      <span className="qn-row-copy">
                        <span className="qn-list-primary">{conn.name}</span>
                        <span className="qn-subtitle block">{current ? '当前电脑 · ' : ''}{formatAddress(conn.host, conn.port)}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={tone}>{repair ? '重新配对' : stateText[status]}</Badge>
                        {latency != null && <span className="text-[11px] text-qn-muted tabular-nums" title="手机到电脑的 HTTPS 探测耗时">{latency} ms</span>}
                      </span>
                    </button>
                    <Button variant="ghost" className="qn-list-action" onClick={() => setMenu(conn.id)} aria-label={`${conn.name} 的连接操作`}>
                      <WorkspaceIcon name="more" />
                    </Button>
                  </div>
                )
              })}
            </div>
            {/* 已有连接时这里不是主操作：只留虚线入口，导入方式在添加页里选。 */}
            <button type="button" className="qn-dashed-action qn-pressable" onClick={openAddForm}>
              <Plus size={17} aria-hidden />添加连接
            </button>
          </>
        )}
      </PullToRefresh>
      {settings && <MobileSettings onClose={() => setSettings(false)} />}
      {selected && (
        <Dialog title={selected.name} onClose={() => setMenu(null)}>
          <p className="mb-3 text-xs text-qn-muted">{formatAddress(selected.host, selected.port)}</p>
          <div className="grid gap-2">
            <Button onClick={() => { setMenu(null); openEditForm(selected.id) }}>编辑连接</Button>
            <Button onClick={() => { setMenu(null); beginRepair(selected.id) }}>重新配对</Button>
            <Button variant="danger" onClick={() => { setMenu(null); setPendingDelete(selected.id) }}>删除连接</Button>
          </div>
        </Dialog>
      )}
      {pendingDelete && (
        <Dialog title="删除连接" onClose={() => setPendingDelete(null)}>
          <p className="mb-4 text-sm text-qn-muted">删除后需要重新配对才能访问这台电脑。</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button className="flex-1" variant="danger" onClick={() => {
              const id = pendingDelete
              setPendingDelete(null)
              void removeConnection(id)
            }}>删除</Button>
          </div>
        </Dialog>
      )}
    </>
  )
}

export function ConnectionFormPage() {
  const form = useApp((s) => s.form)
  const closeForm = useApp((s) => s.closeForm)
  const setFormPaste = useApp((s) => s.setFormPaste)
  const parsePaste = useApp((s) => s.parsePaste)
  const pasteFromClipboard = useApp((s) => s.pasteFromClipboard)
  const updateDraft = useApp((s) => s.updateDraft)
  const testConnection = useApp((s) => s.testConnection)
  const pairAndSave = useApp((s) => s.pairAndSave)
  const saveEdit = useApp((s) => s.saveEdit)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  if (!form) return null
  const isEdit = form.mode === 'edit'
  const isRepair = form.mode === 'repair'
  const title = isEdit ? '编辑连接' : isRepair ? '重新配对' : '添加连接'
  const imported = Boolean(normalizeFingerprint(form.draft.fp))
  const codeOk = isValidPairingCode(form.draft.code)
  const onHostBlur = () => {
    const parsed = parseAddress(form.draft.host)
    if (parsed && parsed.host !== form.draft.host) {
      updateDraft('host', parsed.host)
      if (parsed.port !== null) updateDraft('port', String(parsed.port))
    }
  }

  const scan = async () => {
    const requestForm = useApp.getState().form
    setScanning(true)
    setScanError(null)
    try {
      const link = await callDevice<string | null>('pair.scan', {}, 300_000)
      if (!link || requestForm !== useApp.getState().form) return
      if (!parsePairingLink(link)) {
        setScanError('二维码里没有可用的 QingCode Next 配对链接。')
        return
      }
      setFormPaste(link)
      parsePaste()
    } catch (err) {
      setScanError(friendlyError(err, '扫码不可用，可用系统相机或粘贴连接信息。'))
    } finally {
      setScanning(false)
    }
  }

  return (
    <>
      <Header title={title}
        subtitle={isEdit ? '修改名称或地址' : isRepair ? '请从同一台电脑复制新的连接信息' : '配对到自己的电脑'}
        onBack={form.saving ? undefined : closeForm} />
      <fieldset className="qn-body qn-scroll min-w-0" disabled={form.saving}>
        {!isEdit && (
          <Card className="mb-3">
            <p className="mb-3 text-sm">在电脑端「手机连接」复制连接信息，再在这里导入。</p>
            <Button className="w-full" onClick={() => { setScanError(null); void pasteFromClipboard() }}>
              从剪贴板导入
            </Button>
            {getWindowNativePort() && (
              <Button className="mt-2 w-full" disabled={scanning} onClick={() => void scan()}>
                {scanning ? '正在扫码…' : '扫码导入'}
              </Button>
            )}
            <details className="qn-details mt-1">
              <summary>手动粘贴</summary>
              <Field label="连接信息">
                <textarea className="qn-textarea" rows={3} value={form.paste} placeholder="粘贴电脑端复制的连接信息…"
                  onChange={(event) => setFormPaste(event.target.value)} />
              </Field>
              <Button className="w-full" disabled={!form.paste.trim()} onClick={parsePaste}>导入信息</Button>
            </details>
            {scanError && <Note message={scanError} tone="warn" onClose={() => setScanError(null)} />}
          </Card>
        )}

        {(imported || isEdit) && (
          <Card>
            <Field label="名称">
              <input className="qn-input" value={form.draft.name} placeholder="例如：工作电脑"
                onChange={(event) => updateDraft('name', event.target.value)} />
            </Field>
            <p className="qn-subtitle qn-mono mb-1">{formatAddress(form.draft.host, Number(form.draft.port))}</p>
            <details className="qn-details" open={isEdit || undefined}>
              <summary>地址、端口和证书指纹</summary>
              <Field label="主机" hint="IPv4、IPv6 或域名，也可输入 host:port">
                <input className="qn-input qn-mono" value={form.draft.host} placeholder="例如 frp.example.com:7001"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(event) => updateDraft('host', event.target.value)} onBlur={onHostBlur} />
              </Field>
              <Field label="端口">
                <input className="qn-input qn-mono" inputMode="numeric" value={form.draft.port}
                  onChange={(event) => updateDraft('port', event.target.value)} />
              </Field>
              <div className="qn-label">证书指纹</div>
              <div className="qn-mono mb-3 rounded-xl border border-qn-border bg-black/20 p-2 text-xs">
                {normalizeFingerprint(form.draft.fp) ?? '待导入'}
              </div>
            </details>
            {!isEdit && (
              <Field label="配对密码" hint="只在配对时使用">
                <input className="qn-input" type="password" value={form.draft.code} placeholder="电脑端设置的配对密码"
                  autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(event) => updateDraft('code', event.target.value)} />
              </Field>
            )}
            {isEdit && (
              <details className="qn-details">
                <summary>从新连接信息导入地址</summary>
                <Field label="新连接信息">
                  <textarea className="qn-textarea" rows={2} value={form.paste}
                    onChange={(event) => setFormPaste(event.target.value)} />
                </Field>
                <div className="mb-3 flex flex-wrap gap-2">
                  <Button className="flex-1" onClick={() => void pasteFromClipboard()}>从剪贴板导入</Button>
                  <Button className="flex-1" disabled={!form.paste.trim()} onClick={parsePaste}>导入地址</Button>
                </div>
              </details>
            )}
            {form.probe && <Note message={`指纹核对通过 · ${form.probe.name || '电脑'}`} tone="ok" />}
            {!isEdit && form.draft.code && !codeOk && <Note message="配对密码需要 6–20 位且不含空白字符。" tone="warn" />}
          </Card>
        )}
        {form.error && <div className="mt-3"><Note message={form.error} tone="error" /></div>}
        {form.fpMismatch && <div className="mt-3"><Note message={form.fpMismatch} tone="error" /></div>}
      </fieldset>
      {(imported || isEdit) && (
        <div className="qn-footer flex flex-wrap gap-2">
          <Button className="flex-1" disabled={form.testing || form.saving} onClick={() => void testConnection()}>
            {form.testing ? '测试中…' : '测试连接'}
          </Button>
          <Button className="flex-1" variant="primary" disabled={form.testing || form.saving || Boolean(form.fpMismatch)}
            onClick={() => void (isEdit ? saveEdit() : pairAndSave())}>
            {form.saving ? '保存中…' : isEdit ? '保存修改' : '配对并保存'}
          </Button>
        </div>
      )}
    </>
  )
}
